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
using System.Windows.Interop;
using System.Windows.Media;

namespace WindowsAgentTestBench
{
    internal sealed class ShopProduct
    {
        public string Sku;
        public string Name;
        public string Category;
        public string Details;
        public int PriceCents;
        public int Stock;
    }

    internal sealed class ShopOrderItem
    {
        public string Sku;
        public string Name;
        public int PriceCents;
        public int Quantity;
    }

    internal sealed class ShopOrder
    {
        public string Id;
        public string Recipient;
        public string Phone;
        public string Address;
        public List<ShopOrderItem> Items;
        public int TotalCents;
        public string Status;
        public string PaymentMethod;
    }

    internal sealed class ShoppingWindow : Window
    {
        private readonly string mode;
        private readonly int seed;
        private readonly string pipeName;
        private readonly string secret;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly CancellationTokenSource serverStop = new CancellationTokenSource();
        private readonly List<ShopProduct> products = new List<ShopProduct> {
            new ShopProduct { Sku = "RAM-32G-01", Name = "星云 32GB DDR5 笔记本内存条", Category = "电脑配件", Details = "32GB · DDR5 5600MHz · 笔记本适用", PriceCents = 89900, Stock = 12 },
            new ShopProduct { Sku = "RAM-16G-02", Name = "星云 16GB DDR4 台式机内存条", Category = "电脑配件", Details = "16GB · DDR4 3200MHz · 台式机适用", PriceCents = 35900, Stock = 18 },
            new ShopProduct { Sku = "SSD-1T-03", Name = "极光 1TB 固态硬盘", Category = "电脑配件", Details = "1TB · NVMe · PCIe 4.0", PriceCents = 52900, Stock = 9 },
            new ShopProduct { Sku = "KEY-87-04", Name = "山岚 87 键机械键盘", Category = "桌面设备", Details = "87 键 · 有线连接 · 热插拔", PriceCents = 42900, Stock = 16 },
            new ShopProduct { Sku = "MOU-05", Name = "轻羽无线鼠标", Category = "桌面设备", Details = "无线连接 · 静音按键", PriceCents = 12900, Stock = 24 },
            new ShopProduct { Sku = "MON-27-06", Name = "远山 27 英寸显示器", Category = "显示设备", Details = "27 英寸 · 2K · 100Hz", PriceCents = 139900, Stock = 6 }
        };
        private readonly Dictionary<string, int> cart = new Dictionary<string, int>();
        private readonly List<ShopOrder> orders = new List<ShopOrder>();
        private readonly List<string> searches = new List<string>();
        private Grid shell;
        private Grid confirmationOverlay;
        private StackPanel sidebar;
        private ScrollViewer pageScroll;
        private StackPanel content;
        private TextBlock banner;
        private TextBox searchBox;
        private TextBox recipientBox;
        private TextBox phoneBox;
        private TextBox addressBox;
        private ComboBox paymentBox;
        private StackPanel resultsPanel;
        private ShopOrder activeOrder;
        private bool firstAddIgnored;
        private int actionFailures;
        private int nextOrder = 1001;
        private int searchVersion;

        public ShoppingWindow(string mode, int seed, string pipeName, string secret)
        {
            RenderOptions.ProcessRenderMode = RenderMode.SoftwareOnly;
            this.mode = mode;
            this.seed = seed;
            this.pipeName = pipeName;
            this.secret = secret;
            var random = new Random(seed);
            Title = "Windows Agent TestBench - 模拟商城";
            Width = 1060 + random.Next(-50, 51);
            Height = 740 + random.Next(-30, 31);
            MinWidth = 850;
            MinHeight = 600;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Background = new SolidColorBrush(Color.FromRgb(245, 248, 248));
            BuildShell();
            ShowCatalog();
            Loaded += (s, e) => Task.Run(() => Serve(serverStop.Token));
            Closed += (s, e) => serverStop.Cancel();
        }

        private static string Money(int cents) { return "¥" + (cents / 100m).ToString("0.00", CultureInfo.InvariantCulture); }
        private static TextBlock Label(string value, int size, bool bold = false)
        {
            return new TextBlock { Text = value, FontSize = size,
                FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal,
                Foreground = new SolidColorBrush(Color.FromRgb(32, 48, 58)),
                TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 9) };
        }
        private static Button ActionButton(string title, Action action)
        {
            var button = new Button { Content = title, MinWidth = 110, Height = 38,
                Margin = new Thickness(0, 0, 9, 9), Padding = new Thickness(12, 4, 12, 4),
                Background = new SolidColorBrush(Color.FromRgb(27, 111, 99)), Foreground = Brushes.White,
                BorderThickness = new Thickness(0) };
            button.Click += (s, e) => action();
            return button;
        }
        private static TextBox Input(string automationName, int width)
        {
            var box = new TextBox { Width = width, Height = 36, Padding = new Thickness(8, 5, 8, 5),
                HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 0, 0, 15) };
            box.SetValue(System.Windows.Automation.AutomationProperties.NameProperty, automationName);
            box.SetValue(System.Windows.Automation.AutomationProperties.AutomationIdProperty, "shop-" + automationName);
            return box;
        }
        private void BuildShell()
        {
            shell = new Grid();
            shell.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(210) });
            shell.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            sidebar = new StackPanel { Background = new SolidColorBrush(Color.FromRgb(24, 52, 61)) };
            sidebar.Children.Add(new TextBlock { Text = "拾光商城", FontSize = 23, FontWeight = FontWeights.Bold,
                Foreground = Brushes.White, Margin = new Thickness(18, 25, 10, 5) });
            sidebar.Children.Add(new TextBlock { Text = "Agent TestBench · 本地模拟", FontSize = 11,
                Foreground = Brushes.LightGray, Margin = new Thickness(18, 0, 10, 30) });
            AddNav(sidebar, "商品搜索", ShowCatalog);
            AddNav(sidebar, "购物车", ShowCart);
            AddNav(sidebar, "我的订单", ShowOrders);
            sidebar.Children.Add(new TextBlock { Text = "所有商品和支付均为虚构数据", FontSize = 11,
                Foreground = Brushes.LightGray, TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(18, 30, 18, 0) });
            pageScroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            content = new StackPanel { Margin = new Thickness(30, 27, 30, 30) };
            pageScroll.Content = content;
            if (mode == "ui-changed") {
                shell.ColumnDefinitions[0].Width = new GridLength(1, GridUnitType.Star);
                shell.ColumnDefinitions[1].Width = new GridLength(210);
                Grid.SetColumn(pageScroll, 0); Grid.SetColumn(sidebar, 1);
            } else { Grid.SetColumn(sidebar, 0); Grid.SetColumn(pageScroll, 1); }
            shell.Children.Add(sidebar); shell.Children.Add(pageScroll); Content = shell;
        }
        private static void AddNav(StackPanel sidebar, string name, Action action)
        {
            var button = new Button { Content = name, Height = 43, Margin = new Thickness(12, 3, 12, 3),
                HorizontalContentAlignment = HorizontalAlignment.Left, Padding = new Thickness(15, 0, 0, 0),
                Background = new SolidColorBrush(Color.FromRgb(42, 80, 87)), Foreground = Brushes.White,
                BorderThickness = new Thickness(0) };
            button.Click += (s, e) => action(); sidebar.Children.Add(button);
        }
        private void Page(string title, string hint)
        {
            content.Children.Clear();
            content.Children.Add(Label(title, 27, true));
            content.Children.Add(Label(hint, 13));
            banner = Label("", 13);
            banner.Foreground = new SolidColorBrush(Color.FromRgb(24, 126, 103));
            content.Children.Add(banner);
        }
        private void ShowCatalog()
        {
            searchVersion++;
            Page("商品搜索", "搜索商品并加入购物车。查询结果会在短暂加载后出现。");
            var searchRow = new StackPanel { Orientation = Orientation.Horizontal };
            searchBox = Input("商品关键词", 360);
            searchRow.Children.Add(searchBox);
            searchRow.Children.Add(ActionButton("搜索商品", async () => await SearchProducts()));
            content.Children.Add(searchRow);
            resultsPanel = new StackPanel();
            content.Children.Add(resultsPanel);
            RenderProducts(products, "精选商品 · 共 " + products.Count + " 件");
        }
        private async Task SearchProducts()
        {
            var version = ++searchVersion;
            var query = searchBox.Text.Trim();
            if (query != "") searches.Add(query);
            resultsPanel.Children.Clear();
            resultsPanel.Children.Add(Label("正在搜索商品…", 14));
            var panel = resultsPanel;
            await Task.Delay(mode == "slow-network" ? 5000 : 650);
            if (version != searchVersion || !content.Children.Contains(panel)) return;
            var tokens = query.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            var matches = products.Where(p => tokens.All(token =>
                (p.Name + " " + p.Details + " " + p.Sku).IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0)).ToList();
            if (mode == "ui-changed") matches.Reverse();
            RenderProducts(matches, query == "" ? "全部商品 · 共 " + matches.Count + " 件" :
                "搜索“" + query + "”找到 " + matches.Count + " 件商品");
        }
        private void RenderProducts(IEnumerable<ShopProduct> matches, string title)
        {
            resultsPanel.Children.Clear();
            resultsPanel.Children.Add(Label(title, 16, true));
            var items = matches.ToList();
            if (items.Count == 0) { resultsPanel.Children.Add(Label("没有找到匹配商品，请更换关键词。", 14)); return; }
            foreach (var product in items) {
                var card = new Border { Background = Brushes.White, BorderBrush = new SolidColorBrush(Color.FromRgb(218, 229, 229)),
                    BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8),
                    Padding = new Thickness(16), Margin = new Thickness(0, 0, 0, 11) };
                var row = new Grid();
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                var info = new StackPanel();
                info.Children.Add(Label(product.Name, 16, true));
                info.Children.Add(Label(product.Details, 12));
                info.Children.Add(Label("编号 " + product.Sku + " · 库存 " + product.Stock + " · " + Money(product.PriceCents), 13));
                var add = ActionButton("加入购物车 · " + product.Name, () => AddToCart(product));
                add.IsEnabled = product.Stock > 0;
                Grid.SetColumn(info, 0); Grid.SetColumn(add, 1);
                row.Children.Add(info); row.Children.Add(add);
                card.Child = row; resultsPanel.Children.Add(card);
            }
        }
        private void AddToCart(ShopProduct product)
        {
            if (mode == "action-failure" && !firstAddIgnored) {
                firstAddIgnored = true; actionFailures++; banner.Text = "服务繁忙，商品尚未加入，请重试"; return;
            }
            var count = cart.ContainsKey(product.Sku) ? cart[product.Sku] : 0;
            if (count >= product.Stock) { banner.Text = "库存不足"; return; }
            cart[product.Sku] = count + 1;
            banner.Text = "已加入购物车：" + product.Name + " · 当前数量 " + cart[product.Sku];
        }
        private void ShowCart()
        {
            Page("购物车", "调整数量后进入结算。购物车中的商品尚未创建订单。");
            if (cart.Count == 0) { content.Children.Add(Label("购物车为空", 17)); content.Children.Add(ActionButton("继续选购", ShowCatalog)); return; }
            foreach (var entry in cart.ToList()) {
                var product = products.First(p => p.Sku == entry.Key);
                var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 10) };
                row.Children.Add(Label(product.Name + " · " + Money(product.PriceCents) + " · 数量 " + entry.Value, 14, true));
                row.Children.Add(ActionButton("减少 " + product.Name, () => ChangeQuantity(product, -1)));
                row.Children.Add(ActionButton("增加 " + product.Name, () => ChangeQuantity(product, 1)));
                content.Children.Add(row);
            }
            content.Children.Add(Label("商品合计：" + Money(CartTotal()), 18, true));
            content.Children.Add(ActionButton("去结算", ShowCheckout));
        }
        private void ChangeQuantity(ShopProduct product, int delta)
        {
            var next = cart[product.Sku] + delta;
            if (next > product.Stock) { banner.Text = "库存不足"; return; }
            if (next <= 0) cart.Remove(product.Sku); else cart[product.Sku] = next;
            ShowCart();
        }
        private int CartTotal()
        {
            return cart.Sum(entry => products.First(p => p.Sku == entry.Key).PriceCents * entry.Value);
        }
        private void ShowCheckout()
        {
            if (cart.Count == 0) { ShowCart(); return; }
            Page("填写收货信息", "提交后将创建待支付的模拟订单。");
            content.Children.Add(Label("收货人", 13, true));
            recipientBox = Input("收货人", 350); content.Children.Add(recipientBox);
            content.Children.Add(Label("手机号", 13, true));
            phoneBox = Input("手机号", 350); content.Children.Add(phoneBox);
            content.Children.Add(Label("详细地址", 13, true));
            addressBox = Input("详细地址", 500); addressBox.Height = 68;
            addressBox.AcceptsReturn = true; addressBox.TextWrapping = TextWrapping.Wrap;
            content.Children.Add(addressBox);
            content.Children.Add(Label("待支付：" + Money(CartTotal()), 18, true));
            content.Children.Add(ActionButton("提交订单", SubmitOrder));
        }
        private void SubmitOrder()
        {
            var recipient = recipientBox.Text.Trim();
            var phone = phoneBox.Text.Trim();
            var address = addressBox.Text.Trim();
            if (recipient == "" || phone.Length != 11 || !phone.All(Char.IsDigit) || !phone.StartsWith("1") || address.Length < 5) {
                banner.Text = "请填写收货人、11 位手机号和详细地址"; return;
            }
            Confirm("确认下单", "确认提交订单？当前商品合计 " + Money(CartTotal()) + "。", "确定下单", CreateOrder);
        }
        private void CreateOrder()
        {
            if (cart.Count == 0) { ShowCart(); return; }
            var recipient = recipientBox.Text.Trim();
            var phone = phoneBox.Text.Trim();
            var address = addressBox.Text.Trim();
            var items = cart.Select(entry => { var p = products.First(x => x.Sku == entry.Key);
                return new ShopOrderItem { Sku = p.Sku, Name = p.Name, PriceCents = p.PriceCents, Quantity = entry.Value }; }).ToList();
            var order = new ShopOrder { Id = "TB" + nextOrder++, Recipient = recipient, Phone = phone,
                Address = address, Items = items, TotalCents = CartTotal(), Status = "待支付", PaymentMethod = "" };
            foreach (var item in items) products.First(p => p.Sku == item.Sku).Stock -= item.Quantity;
            orders.Add(order); cart.Clear(); activeOrder = order;
            ShowPayment(); banner.Text = "订单 " + order.Id + " 已提交，等待模拟支付";
        }
        private void ShowPayment()
        {
            if (activeOrder == null) { ShowOrders(); return; }
            Page("模拟支付", "本地测试支付：无需账号、卡号、密码或验证码，不会真实扣款。");
            content.Children.Add(Label("订单 " + activeOrder.Id + " · 状态：" + activeOrder.Status, 16, true));
            content.Children.Add(Label("支付金额：" + Money(activeOrder.TotalCents), 24, true));
            if (activeOrder.Status == "已支付") {
                content.Children.Add(Label("支付成功，订单状态：已支付", 18, true));
                content.Children.Add(ActionButton("查看我的订单", ShowOrders)); return;
            }
            content.Children.Add(Label("选择模拟支付方式", 13, true));
            paymentBox = new ComboBox { Width = 220, Height = 36, ItemsSource = new[] { "测试余额", "测试银行卡" },
                SelectedIndex = 0, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 0, 0, 18) };
            paymentBox.SetValue(System.Windows.Automation.AutomationProperties.NameProperty, "模拟支付方式");
            content.Children.Add(paymentBox);
            content.Children.Add(ActionButton("确认模拟支付", Pay));
        }
        private void Pay()
        {
            if (activeOrder == null || activeOrder.Status != "待支付") { banner.Text = "订单状态已变化，请重新查看"; return; }
            var method = (string)paymentBox.SelectedItem;
            Confirm("确认模拟支付", "确认使用“" + method + "”完成 " + Money(activeOrder.TotalCents) + " 的模拟支付？",
                "确定支付", () => CompletePayment(method));
        }
        private void CompletePayment(string method)
        {
            if (activeOrder == null || activeOrder.Status != "待支付") return;
            activeOrder.Status = "已支付"; activeOrder.PaymentMethod = method;
            ShowPayment(); banner.Text = "模拟支付成功";
        }
        private void Confirm(string title, string message, string confirmLabel, Action accept)
        {
            if (confirmationOverlay != null) return;
            var overlay = new Grid { Background = new SolidColorBrush(Color.FromArgb(180, 16, 35, 42)) };
            Grid.SetColumnSpan(overlay, 2);
            Panel.SetZIndex(overlay, 10);
            var box = new Border { Width = 460, Padding = new Thickness(25), Background = Brushes.White,
                CornerRadius = new CornerRadius(10), HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center };
            var body = new StackPanel();
            body.Children.Add(Label(title, 20, true));
            body.Children.Add(Label(message, 14));
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right,
                Margin = new Thickness(0, 14, 0, 0) };
            Action close = () => { shell.Children.Remove(overlay); confirmationOverlay = null;
                sidebar.IsEnabled = true; pageScroll.IsEnabled = true; };
            buttons.Children.Add(ActionButton("取消", close));
            buttons.Children.Add(ActionButton(confirmLabel, () => { close(); accept(); }));
            body.Children.Add(buttons); box.Child = body; overlay.Children.Add(box);
            confirmationOverlay = overlay;
            sidebar.IsEnabled = false; pageScroll.IsEnabled = false;
            shell.Children.Add(overlay);
        }
        private void ShowOrders()
        {
            Page("我的订单", "查看模拟订单及其支付状态。");
            if (orders.Count == 0) { content.Children.Add(Label("暂无订单", 16)); return; }
            foreach (var order in orders.AsEnumerable().Reverse()) {
                content.Children.Add(Label("订单 " + order.Id + " · " + order.Status + " · " + Money(order.TotalCents), 17, true));
                content.Children.Add(Label(order.Recipient + " · " + String.Join("、", order.Items.Select(x => x.Name + " × " + x.Quantity)), 13));
                if (order.Status == "待支付") content.Children.Add(ActionButton("支付订单 " + order.Id, () => {
                    activeOrder = order; ShowPayment(); }));
            }
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
            var fields = expected.Split(new[] { ',' }, 3);
            var sku = fields.Length > 0 ? fields[0] : "";
            int quantity;
            if (fields.Length < 2 || !Int32.TryParse(fields[1], out quantity)) quantity = 1;
            var recipient = fields.Length > 2 ? fields[2] : "";
            var checks = new Dictionary<string, bool>();
            if (task == "shop-search") checks["searched"] = expected != "" && searches.Any(x => x.Contains(expected));
            if (task == "shop-cart") checks["cart"] = sku != "" && cart.ContainsKey(sku) && cart[sku] == quantity;
            var matchingOrders = orders.Where(order =>
                (recipient == "" || order.Recipient == recipient) &&
                order.Items.Any(item => item.Sku == sku && item.Quantity == quantity)).ToList();
            if (task == "shop-order" || task == "shop-paid") checks["order"] = sku != "" && matchingOrders.Count > 0;
            if (task == "shop-paid") checks["paid"] = matchingOrders.Any(order => order.Status == "已支付");
            return new { task = task, pass = checks.Count > 0 && checks.Values.All(x => x), checks = checks,
                truth = new { searches = searches.ToArray(), cart = cart.Select(entry => new { sku = entry.Key, quantity = entry.Value }).ToArray(),
                    orders = orders.Select(order => new { id = order.Id, recipient = order.Recipient, phone = order.Phone,
                        address = order.Address, items = order.Items.Select(item => new { sku = item.Sku, name = item.Name,
                            quantity = item.Quantity, priceCents = item.PriceCents }).ToArray(),
                        totalCents = order.TotalCents, status = order.Status, paymentMethod = order.PaymentMethod }).ToArray() },
                metrics = new { searchCount = searches.Count, actionFailures = actionFailures },
                variant = new { mode = mode, seed = seed } };
        }
    }
}
