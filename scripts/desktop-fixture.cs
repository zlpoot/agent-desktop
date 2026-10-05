using System;
using System.Drawing;
using System.Windows.Forms;

public class DesktopFixture : Form
{
    private readonly TextBox input = new TextBox();
    private readonly Label result = new Label();

    public DesktopFixture(string suffix)
    {
        Text = "Computer Use M5 验证窗口 " + suffix;
        Width = 540;
        Height = 240;

        var prompt = new Label { Text = "请输入测试内容", Left = 24, Top = 22, Width = 220 };
        input.Left = 24;
        input.Top = 55;
        input.Width = 430;
        input.AccessibleName = "输入内容";
        var button = new Button { Text = "处理", Left = 24, Top = 98, Width = 100 };
        button.AccessibleName = "处理";
        result.Text = "等待操作";
        result.Left = 24;
        result.Top = 145;
        result.Width = 430;
        button.Click += (sender, args) => result.Text = "已处理：" + input.Text;
        Controls.Add(prompt);
        Controls.Add(input);
        Controls.Add(button);
        Controls.Add(result);
    }

    [STAThread]
    public static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new DesktopFixture(args.Length > 0 ? args[0] : "测试"));
    }
}
