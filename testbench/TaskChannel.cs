using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Interop;

namespace WindowsAgentTestBench
{
    // Separate from the EVAL Oracle. Only visible AutomationPeer evidence is returned.
    // One channel owns one Window incarnation; no reattachment or substitute window.
    internal sealed class BenchTaskChannel
    {
        [DllImport("kernel32.dll")] private static extern ulong GetTickCount64();
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
        private readonly Window window;
        private readonly string incarnation = Guid.NewGuid().ToString("N");
        private readonly Dictionary<AutomationPeer, string> identities = new Dictionary<AutomationPeer, string>();
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly string pipeName, secret;
        private readonly uint issuer;
        private string observation;
        private ulong observedAt;
        private Dictionary<string, string> observedControls;
        private long sequence;
        private IntPtr originalHandle;
        private bool lifetimeEnded;
        private BenchRegistryFence registry;
        private readonly CancellationTokenSource stop = new CancellationTokenSource();
        public BenchTaskChannel(Window window)
        {
            this.window = window;
            pipeName = Environment.GetEnvironmentVariable("AGENT_BENCH_TASK_PIPE");
            secret = Environment.GetEnvironmentVariable("AGENT_BENCH_TASK_SECRET");
            uint.TryParse(Environment.GetEnvironmentVariable("AGENT_BENCH_TASK_ISSUER"), out issuer);
            if (String.IsNullOrEmpty(pipeName) || String.IsNullOrEmpty(secret) || issuer == 0) return;
            window.SourceInitialized += (s, e) => originalHandle = new WindowInteropHelper(window).Handle;
            window.Closed += (s, e) => lifetimeEnded = true;
            window.Loaded += (s, e) => Task.Run(() => Serve());
            window.Closed += (s, e) => stop.Cancel();
        }
        private IEnumerable<AutomationPeer> Peers(AutomationPeer root, int depth = 0)
        {
            if (depth > 32) throw new InvalidOperationException("peer-depth-budget");
            yield return root;
            var children = root.GetChildren();
            if (children != null) foreach (var child in children)
                foreach (var peer in Peers(child, depth + 1)) yield return peer;
        }
        private string Id(AutomationPeer peer)
        {
            string id;
            if (!identities.TryGetValue(peer, out id)) {
                if (identities.Count >= 4096) throw new InvalidOperationException("peer-history-budget");
                identities.Add(peer, id = Guid.NewGuid().ToString("N"));
            }
            return id;
        }
        private List<AutomationPeer> Current()
        {
            if (lifetimeEnded || !window.IsVisible || originalHandle == IntPtr.Zero || new WindowInteropHelper(window).Handle != originalHandle)
                throw new InvalidOperationException("original-window-closed");
            var peers = Peers(UIElementAutomationPeer.CreatePeerForElement(window)).Distinct()
                .Where(p => !p.IsOffscreen()).ToList();
            if (peers.Count > 512) throw new InvalidOperationException("peer-budget");
            return peers;
        }
        private static string Role(AutomationPeer peer)
        {
            var kind = peer.GetAutomationControlType();
            if (kind == AutomationControlType.Edit) return "edit";
            if (kind == AutomationControlType.Button) return "button";
            if (kind == AutomationControlType.Text) return "text";
            return kind.ToString().ToLowerInvariant();
        }
        private object Snapshot()
        {
            var started = GetTickCount64();
            var peers = Current();
            observation = Guid.NewGuid().ToString("N"); observedAt = GetTickCount64();
            observedControls = peers.ToDictionary(Id, p => Role(p) + "|" + p.GetName());
            var items = peers.Select(p => {
                var item = new Dictionary<string, object> {
                    {"identity", Id(p)}, {"role", Role(p)}, {"name", p.GetName()}, {"complete", true}
                };
                var element = p as FrameworkElementAutomationPeer;
                var edit = element == null ? null : element.Owner as TextBox;
                if (edit != null) item["value"] = edit.Text;
                var combo = element == null ? null : element.Owner as ComboBox;
                if (combo != null) item["value"] = Convert.ToString(combo.SelectedItem);
                return item;
            }).ToArray();
            var text = String.Join("\n", items.Select(i => (string)i["name"] + (i.ContainsKey("value") ? " " + Convert.ToString(i["value"]) : "")).Where(n => n != ""));
            return new {
                incarnation, observation, sequence = ++sequence, startedAt = started, finishedAt = GetTickCount64(),
                hwnd = new WindowInteropHelper(window).Handle.ToInt64(),
                pid = System.Diagnostics.Process.GetCurrentProcess().Id, title = window.Title,
                text, items
            };
        }
        private object Dispatch(Dictionary<string, object> request)
        {
            string method = (string)request["method"];
            if (method == "observe") return Snapshot();
            if (method == "bind") {
                if (registry != null) throw new InvalidOperationException("producer-bind-reused");
                Current();
                registry = new BenchRegistryFence((string)request["registry"], (Dictionary<string, object>)request["profile"]);
                return registry.Run(() => new { bound = true });
            }
            if (method != "execute") throw new InvalidOperationException("unsupported-method");
            if (registry == null) throw new InvalidOperationException("producer-not-bound");
            return registry.Run(() => Commit(request));
        }
        private object Commit(Dictionary<string, object> request)
        {
            // Consume the observation even on rejection; no queued/retried input.
            var token = observation; observation = null;
            if ((string)request["incarnation"] != incarnation || (string)request["observation"] != token ||
                token == null || GetTickCount64() - observedAt >= 5000 ||
                GetTickCount64() >= Convert.ToUInt64(request["leaseDeadline"]))
                throw new InvalidOperationException("stale-producer-admission");
            var action = (Dictionary<string, object>)request["action"];
            var target = (Dictionary<string, object>)action["target"];
            if ((string)target["kind"] != "role") throw new InvalidOperationException("semantic-target-required");
            string role = (string)target["role"], name = (string)target["name"];
            var matches = Current().Where(p => Role(p) == role && p.GetName() == name).ToArray();
            string signature;
            if (matches.Length != 1 || !matches[0].IsEnabled() ||
                !observedControls.TryGetValue(Id(matches[0]), out signature) || signature != role + "|" + name)
                throw new InvalidOperationException("control-incarnation-changed");
            var peer = matches[0] as FrameworkElementAutomationPeer;
            if (peer == null) throw new InvalidOperationException("native-peer-required");
            string kind = (string)action["kind"];
            var button = peer.Owner as Button;
            var edit = peer.Owner as TextBox;
            var readButtons = new[] { "工作台", "客户管理", "订单管理", "系统设置", "查询客户",
                "打开李四资料", "打开张三资料", "查看客户订单", "查询订单", "打开 O2026-1003", "打开 O2026-1004" };
            // Synchronous routed event, NOT IInvokeProvider.Invoke's deferred dispatcher callback.
            // The actual UI producer Registry transaction covers this synchronous event.
            if (GetTickCount64() >= Convert.ToUInt64(request["leaseDeadline"]))
                throw new InvalidOperationException("expired-producer-lease");
            if (kind == "click" && role == "button" && button != null && readButtons.Contains(name)) {
                button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); return new { committed = true };
            }
            if (kind == "type" && role == "edit" && (name == "客户姓名" || name == "订单客户姓名") && edit != null) {
                string text = (string)action["text"];
                if (text.Length > 80 || text.Any(Char.IsControl)) throw new InvalidOperationException("text-budget");
                edit.Text = text; return new { committed = true };
            }
            throw new InvalidOperationException("testbench-read-query-action-required");
        }
        private async Task Serve()
        {
            var acl = new PipeSecurity();
            acl.SetAccessRuleProtection(true, false);
            acl.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
            while (!stop.IsCancellationRequested) {
                using (var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 8192, 8192, acl)) {
                    try {
                        await pipe.WaitForConnectionAsync(stop.Token);
                        uint client;
                        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out client) || client != issuer)
                            throw new InvalidOperationException("foreign-issuer");
                        using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true))
                        using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true) { AutoFlush = true }) {
                            var input = new StringBuilder();
                            int ch;
                            while ((ch = reader.Read()) != -1 && ch != '\n') {
                                if (input.Length >= 8192) throw new InvalidOperationException("request-budget");
                                input.Append((char)ch);
                            }
                            var request = json.Deserialize<Dictionary<string, object>>(input.ToString());
                            if ((string)request["secret"] != secret) throw new InvalidOperationException("foreign-channel");
                            object result;
                            try { result = window.Dispatcher.Invoke(() => Dispatch(request)); }
                            catch (Exception) { result = new { error = "testbench-producer-rejected" }; }
                            await writer.WriteLineAsync(json.Serialize(result));
                        }
                    } catch (OperationCanceledException) { break; }
                    catch (Exception) { if (stop.IsCancellationRequested) break; }
                }
            }
        }
    }
}
