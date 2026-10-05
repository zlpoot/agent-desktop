using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation.Peers;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using Microsoft.Win32;

namespace WindowsAgentTestBench
{
    internal sealed class AppState
    {
        public string CustomerId = "C1003";
        public string CustomerName = "张三";
        public string Phone = "13800000000";
        public bool AutoSave;
        public int Volume = 25;
        public string OrderId = "O2026-1003";
        public string Delivery = "普通";
        public string Note = "";
        public string Attachment = "";
        public string Status = "草稿";
        public string Priority = "普通";
        public int QueryCount;
        public int ActionFailures;
    }

    // 不发布按钮的 UIA 语义和文字；视觉层仍能看到并点击。
    internal sealed class PaintButton : FrameworkElement
    {
        private readonly string label;
        private readonly Action action;
        public PaintButton(string label, Action action)
        {
            this.label = label;
            this.action = action;
            Width = 110; Height = 34; Margin = new Thickness(0, 0, 10, 10); Cursor = Cursors.Hand;
        }
        protected override AutomationPeer OnCreateAutomationPeer() { return null; }
        protected override void OnRender(DrawingContext drawing)
        {
            drawing.DrawRectangle(Brushes.SteelBlue, null, new Rect(0, 0, ActualWidth, ActualHeight));
            var text = new FormattedText(label, CultureInfo.CurrentUICulture, FlowDirection.LeftToRight,
                new Typeface("Microsoft YaHei"), 14, Brushes.White, VisualTreeHelper.GetDpi(this).PixelsPerDip);
            drawing.DrawText(text, new Point(19, 7));
        }
        protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e) { action(); e.Handled = true; }
    }

    internal sealed class BenchWindow : Window
    {
        private readonly AppState state = new AppState();
        private readonly string mode;
        private readonly int seed;
        private readonly string pipeName;
        private readonly string secret;
        private readonly Random random;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private Grid root;
        private StackPanel sidebar;
        private StackPanel content;
        private TextBlock banner;
        private TextBox customerQuery;
        private TextBox phoneBox;
        private TextBox noteBox;
        private ComboBox deliveryBox;
        private CheckBox autoSaveBox;
        private TextBlock attachmentLabel;
        private TextBlock volumeLabel;
        private Rectangle volumeFill;
        private bool firstSubmitIgnored;
        private CancellationTokenSource serverStop = new CancellationTokenSource();

        public BenchWindow(string mode, int seed, string pipeName, string secret, string customer,
            string initialPhone = "", string startView = "home")
        {
            this.mode = mode;
            this.seed = seed;
            this.pipeName = pipeName;
            this.secret = secret;
            random = new Random(seed);
            state.CustomerName = customer == "李四" ? "李四" : "张三";
            state.CustomerId = customer == "李四" ? "C1004" : "C1003";
            state.OrderId = customer == "李四" ? "O2026-1004" : "O2026-1003";
            if (initialPhone.Length == 11 && initialPhone.All(Char.IsDigit)) state.Phone = initialPhone;
            Title = "Windows Agent TestBench - 仓库与订单管理";
            Width = 1040 + random.Next(-80, 81);
            Height = 720 + random.Next(-40, 41);
            MinWidth = 840;
            MinHeight = 600;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Background = Brushes.White;
            BuildShell();
            if (startView == "customer") ShowCustomerDetail();
            else ShowHome();
            Loaded += (s, e) => Task.Run(() => Serve(serverStop.Token));
            Closed += (s, e) => serverStop.Cancel();
        }

        private static TextBlock Text(string value, int size, bool bold = false)
        {
            return new TextBlock { Text = value, FontSize = size, FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal,
                Foreground = Brushes.Black, Margin = new Thickness(0, 0, 0, 10), TextWrapping = TextWrapping.Wrap };
        }

        private static Button Button(string label, Action action)
        {
            var button = new Button { Content = label, MinWidth = 100, Height = 34, Margin = new Thickness(0, 0, 10, 10),
                Padding = new Thickness(10, 3, 10, 3) };
            button.Click += (s, e) => action();
            return button;
        }

        private void BuildShell()
        {
            root = new Grid();
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(205) });
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            sidebar = new StackPanel { Background = new SolidColorBrush(Color.FromRgb(28, 41, 58)), Margin = new Thickness(0),
                VerticalAlignment = VerticalAlignment.Stretch };
            sidebar.Children.Add(new TextBlock { Text = "Agent TestBench", FontSize = 20, FontWeight = FontWeights.Bold,
                Foreground = Brushes.White, Margin = new Thickness(18, 22, 8, 22) });
            AddNav("工作台", ShowHome);
            AddNav("客户管理", ShowCustomers);
            AddNav("订单管理", ShowOrders);
            AddNav("系统设置", ShowSettings);
            var scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            content = new StackPanel { Margin = new Thickness(28, 23, 28, 24) };
            scroll.Content = content;
            if (mode == "ui-changed") { Grid.SetColumn(scroll, 0); Grid.SetColumn(sidebar, 1);
                root.ColumnDefinitions[0].Width = new GridLength(1, GridUnitType.Star);
                root.ColumnDefinitions[1].Width = new GridLength(205); }
            else { Grid.SetColumn(sidebar, 0); Grid.SetColumn(scroll, 1); }
            root.Children.Add(sidebar);
            root.Children.Add(scroll);
            Content = root;
        }

        private void AddNav(string label, Action action)
        {
            var button = new Button { Content = label, Margin = new Thickness(12, 3, 12, 3), Height = 41,
                HorizontalContentAlignment = HorizontalAlignment.Left, Padding = new Thickness(15, 0, 0, 0),
                Foreground = Brushes.White, Background = new SolidColorBrush(Color.FromRgb(42, 61, 82)),
                BorderThickness = new Thickness(0) };
            button.Click += (s, e) => action();
            sidebar.Children.Add(button);
        }

        private void Page(string title, string hint)
        {
            content.Children.Clear();
            content.Children.Add(Text(title, 26, true));
            content.Children.Add(Text(hint, 13));
            banner = Text("", 13);
            banner.Foreground = Brushes.DarkSlateBlue;
            content.Children.Add(banner);
        }

        private void ShowHome()
        {
            Page("工作台", "这是一个仓库与订单管理系统。请从左侧选择需要处理的业务。");
            content.Children.Add(Text("待办：客户资料维护、订单审核、系统设置", 16));
            content.Children.Add(Text("今日订单：O2026-1003、O2026-1004、O2026-1005", 14));
        }

        private void ShowCustomers()
        {
            Page("客户管理", "可按姓名查找客户，打开后编辑资料。");
            customerQuery = new TextBox { Height = 34, Width = 300, HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(0, 0, 0, 10) };
            customerQuery.SetValue(System.Windows.Automation.AutomationProperties.NameProperty, "客户姓名");
            content.Children.Add(customerQuery);
            content.Children.Add(Button("查询客户", async () => await SearchCustomers()));
            content.Children.Add(new TextBlock { Text = "请输入客户姓名并查询", Name = "CustomerResult" });
        }

        private async Task SearchCustomers()
        {
            var result = content.Children.OfType<TextBlock>().First(x => x.Name == "CustomerResult");
            var input = customerQuery.Text.Trim();
            result.Text = "正在查询…";
            state.QueryCount++;
            await Task.Delay(mode == "slow-network" ? 5000 : 1300);
            if (!content.Children.Contains(result)) return;
            result.Text = input == state.CustomerName ? "查到 1 位客户：" + state.CustomerName + "（" + state.CustomerId + "）" : "没有匹配的客户";
            if (input == state.CustomerName) content.Children.Add(Button("打开" + state.CustomerName + "资料", ShowCustomerDetail));
        }

        private void ShowCustomerDetail()
        {
            Page("客户资料 · " + state.CustomerName, "客户编号 " + state.CustomerId);
            content.Children.Add(Text("手机号", 14, true));
            phoneBox = new TextBox { Text = state.Phone, Height = 34, Width = 300,
                HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 0, 0, 10) };
            phoneBox.SetValue(System.Windows.Automation.AutomationProperties.NameProperty, "手机号");
            content.Children.Add(phoneBox);
            content.Children.Add(Button("保存客户资料", () => {
                // customer-save-rejected：应用明确拒绝本次保存——不写内部 state.Phone（持久值仍为旧号），
                // 输入框缓冲保留用户输入，并给出失败提示。Host 不得读取本模式或该提示，只能在离开后
                // 重开、由应用以新控件身份回填旧值这一重投影事实上判定 FAIL。
                if (mode == "customer-save-rejected") {
                    banner.Foreground = Brushes.Firebrick;
                    banner.Text = "客户资料保存失败：服务暂不可用，本次修改未保存";
                    return;
                }
                state.Phone = phoneBox.Text.Trim();
                banner.Foreground = Brushes.DarkSlateBlue;
                banner.Text = "客户资料已保存";
            }));
            content.Children.Add(Button("查看客户订单", ShowOrderDetail));
        }

        private void ShowOrders()
        {
            Page("订单管理", "订单查询会异步加载；打开订单可修改配送、备注和附件。");
            customerQuery = new TextBox { Height = 34, Width = 300, HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(0, 0, 0, 10) };
            customerQuery.SetValue(System.Windows.Automation.AutomationProperties.NameProperty, "订单客户姓名");
            content.Children.Add(customerQuery);
            content.Children.Add(Button("查询订单", async () => await SearchOrders()));
            content.Children.Add(new TextBlock { Text = "请输入客户姓名并查询", Name = "OrderResult" });
        }

        private async Task SearchOrders()
        {
            var result = content.Children.OfType<TextBlock>().First(x => x.Name == "OrderResult");
            var input = customerQuery.Text.Trim();
            result.Text = "正在加载订单…";
            state.QueryCount++;
            await Task.Delay(mode == "slow-network" ? 5000 : 1500);
            if (!content.Children.Contains(result)) return;
            if (input != state.CustomerName) { result.Text = "没有匹配的订单"; return; }
            var own = state.OrderId + " · " + state.CustomerName + " · 草稿";
            var other = "O2026-1005 · 王五";
            result.Text = mode == "ui-changed" ? other + "\n" + own : own + "\n" + other;
            content.Children.Add(Button("打开 " + state.OrderId, ShowOrderDetail));
        }

        private void ShowOrderDetail()
        {
            Page("订单 " + state.OrderId, "客户：" + state.CustomerName + "（" + state.CustomerId + "）");
            content.Children.Add(Text("配送方式", 14, true));
            deliveryBox = new ComboBox { Width = 220, Height = 34, HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(0, 0, 0, 15), ItemsSource = new[] { "普通", "加急", "自提" } };
            deliveryBox.SetValue(System.Windows.Automation.AutomationProperties.NameProperty, "配送方式");
            deliveryBox.SelectedItem = state.Delivery;
            content.Children.Add(deliveryBox);
            content.Children.Add(Text("订单备注", 14, true));
            noteBox = new TextBox { Text = state.Note, Width = 520, Height = 80, AcceptsReturn = true,
                TextWrapping = TextWrapping.Wrap, HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(0, 0, 0, 15) };
            noteBox.SetValue(System.Windows.Automation.AutomationProperties.NameProperty, "订单备注");
            content.Children.Add(noteBox);
            attachmentLabel = Text("附件：" + (state.Attachment == "" ? "未添加" : System.IO.Path.GetFileName(state.Attachment)), 13);
            content.Children.Add(attachmentLabel);
            content.Children.Add(Button("添加 PDF 附件", SelectAttachment));
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            row.Children.Add(Button("保存订单", SaveOrder));
            if (mode == "uia-missing") row.Children.Add(CustomAction("提交审核", SubmitOrder));
            else row.Children.Add(Button("提交审核", SubmitOrder));
            content.Children.Add(row);
            content.Children.Add(Text("当前状态：" + state.Status, 15, true));
            AddDragBoard();
        }

        private void SelectAttachment()
        {
            var dialog = new OpenFileDialog { Title = "选择订单 PDF 附件", Filter = "PDF 文件|*.pdf" };
            if (dialog.ShowDialog(this) == true) {
                state.Attachment = dialog.FileName;
                attachmentLabel.Text = "附件：" + System.IO.Path.GetFileName(state.Attachment);
                banner.Text = "附件已添加";
            }
        }

        private void SaveOrder()
        {
            state.Delivery = (string)deliveryBox.SelectedItem;
            state.Note = noteBox.Text;
            banner.Text = "订单已保存";
        }

        private void SubmitOrder()
        {
            if (mode == "action-failure" && !firstSubmitIgnored) {
                firstSubmitIgnored = true; state.ActionFailures++; banner.Text = "操作暂未生效，请重新检查"; return;
            }
            if (state.Attachment == "") {
                MessageBox.Show(this, "请先添加 PDF 附件。", "缺少附件", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
            if (mode == "popup" && MessageBox.Show(this, "即将提交审核。请检查附件是否正确。", "附加提醒",
                MessageBoxButton.OKCancel, MessageBoxImage.Information) != MessageBoxResult.OK) return;
            if (MessageBox.Show(this, "确认将此订单提交审核？", "确认提交", MessageBoxButton.OKCancel,
                MessageBoxImage.Question) != MessageBoxResult.OK) return;
            SaveOrder();
            state.Status = "待审核";
            ShowOrderDetail();
            banner.Text = "提交成功：待审核";
        }

        private void ShowSettings()
        {
            Page("系统设置", "通用设置使用标准控件，音量控件为自绘区域。");
            autoSaveBox = new CheckBox { Content = "开启自动保存", IsChecked = state.AutoSave,
                Margin = new Thickness(0, 0, 0, 25) };
            autoSaveBox.Checked += (s, e) => state.AutoSave = true;
            autoSaveBox.Unchecked += (s, e) => state.AutoSave = false;
            content.Children.Add(autoSaveBox);
            content.Children.Add(Text("通知音量（自绘）", 15, true));
            volumeLabel = Text("音量：" + state.Volume + "%", 14);
            content.Children.Add(volumeLabel);
            var canvas = new Canvas { Width = 340, Height = 58, Background = Brushes.LightGray,
                HorizontalAlignment = HorizontalAlignment.Left };
            var track = new Rectangle { Width = 300, Height = 14, Fill = Brushes.SlateGray };
            Canvas.SetLeft(track, 20); Canvas.SetTop(track, 23);
            volumeFill = new Rectangle { Width = state.Volume * 3, Height = 14, Fill = Brushes.SteelBlue };
            Canvas.SetLeft(volumeFill, 20); Canvas.SetTop(volumeFill, 23);
            canvas.Children.Add(track); canvas.Children.Add(volumeFill);
            canvas.MouseLeftButtonDown += (s, e) => { canvas.CaptureMouse(); SetVolume(canvas, e); };
            canvas.MouseMove += (s, e) => { if (canvas.IsMouseCaptured) SetVolume(canvas, e); };
            canvas.MouseLeftButtonUp += (s, e) => { SetVolume(canvas, e); canvas.ReleaseMouseCapture(); };
            content.Children.Add(canvas);
            content.Children.Add(Text("提示：可点击或拖动滑块。", 12));
        }

        private void SetVolume(Canvas canvas, MouseEventArgs e)
        {
            var x = e.GetPosition(canvas).X;
            state.Volume = Math.Max(0, Math.Min(100, (int)Math.Round((x - 20) / 3.0)));
            volumeFill.Width = state.Volume * 3;
            volumeLabel.Text = "音量：" + state.Volume + "%";
        }

        private FrameworkElement CustomAction(string title, Action action)
        {
            return new PaintButton(title, action);
        }

        private void AddDragBoard()
        {
            content.Children.Add(Text("优先级看板（拖拽练习）", 15, true));
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            var card = new Border { Background = Brushes.LightBlue, Padding = new Thickness(14),
                Margin = new Thickness(0, 0, 20, 0), Child = Text("高优先级", 14) };
            card.MouseMove += (s, e) => { if (e.LeftButton == MouseButtonState.Pressed)
                DragDrop.DoDragDrop(card, "高优先级", DragDropEffects.Move); };
            var target = new Border { Background = Brushes.Beige, Padding = new Thickness(14),
                Width = 200, AllowDrop = true, Child = Text("拖到这里：处理中", 14) };
            target.Drop += (s, e) => { if ((string)e.Data.GetData(DataFormats.Text) == "高优先级") {
                state.Priority = "处理中"; ((TextBlock)target.Child).Text = "高优先级：处理中"; } };
            row.Children.Add(card); row.Children.Add(target); content.Children.Add(row);
        }

        private async Task Serve(CancellationToken token)
        {
            while (!token.IsCancellationRequested) {
                using (var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous)) {
                    try {
                        await pipe.WaitForConnectionAsync(token);
                        using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true))
                        using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true) { AutoFlush = true }) {
                            var request = await reader.ReadLineAsync();
                            var response = Dispatcher.Invoke(() => Verify(request));
                            await writer.WriteLineAsync(json.Serialize(response));
                        }
                    } catch (OperationCanceledException) { break; }
                    catch (Exception) { if (token.IsCancellationRequested) break; }
                }
            }
        }

        private object Verify(string request)
        {
            var parts = (request ?? "").Split(new[] { '|' }, 3);
            if (parts.Length < 2 || parts[0] != secret) return new { error = "无权读取测试状态" };
            var task = parts[1];
            var expected = parts.Length > 2 ? parts[2] : "";
            var checks = new Dictionary<string, bool>();
            if (task == "task1") { checks["customer"] = state.CustomerId == (state.CustomerName == "李四" ? "C1004" : "C1003");
                checks["phone"] = expected != "" && state.Phone == expected; }
            if (task == "task2") { checks["volume60"] = state.Volume == 60;
                checks["autoSave"] = state.AutoSave; }
            if (task == "task3") { checks["customer"] = state.CustomerId == (state.CustomerName == "李四" ? "C1004" : "C1003");
                checks["deliveryUrgent"] = state.Delivery == "加急";
                checks["note"] = state.Note == "周五前送达";
                checks["attachment"] = state.Attachment != "" && File.Exists(state.Attachment) &&
                    expected != "" && String.Equals(System.IO.Path.GetFullPath(state.Attachment),
                    System.IO.Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase); }
            if (task == "task3") checks["pendingReview"] = state.Status == "待审核";
            return new { task = task, pass = checks.Count > 0 && checks.Values.All(x => x), checks = checks,
                truth = new { customerId = state.CustomerId, customerName = state.CustomerName,
                    phone = state.Phone, autoSave = state.AutoSave, volume = state.Volume,
                    orderId = state.OrderId, delivery = state.Delivery, note = state.Note,
                    attachment = state.Attachment, status = state.Status, priority = state.Priority },
                metrics = new { queryCount = state.QueryCount, actionFailures = state.ActionFailures },
                variant = new { mode = mode, seed = seed } };
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Func<string, string> arg = key => { var found = args.FirstOrDefault(x => x.StartsWith("--" + key + "="));
                return found == null ? "" : found.Substring(key.Length + 3); };
            var mode = arg("mode");
            int seed;
            if (!int.TryParse(arg("seed"), out seed)) seed = 1;
            var pipe = arg("pipe");
            var secret = arg("secret");
            var customer = arg("customer");
            if (pipe == "" || secret == "") { MessageBox.Show("请使用 run.ps1 启动 TestBench。", "启动错误"); return; }
            var scenario = arg("scenario");
            if (scenario == "shopping") new Application().Run(new ShoppingWindow(mode, seed, pipe, secret));
            else new Application().Run(new BenchWindow(mode, seed, pipe, secret, customer,
                arg("phone"), arg("view")));
        }
    }
}
