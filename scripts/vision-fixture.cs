using System;
using System.Drawing;
using System.Windows.Forms;

// 自绘界面：内部没有可操作的标准 UIA 按钮，用于验收截图视觉定位。
public class VisionFixture : Form
{
    private bool settings;
    private readonly Rectangle button = new Rectangle(235, 150, 170, 64);

    public VisionFixture(string suffix)
    {
        Text = "Computer Use 视觉验证窗口 " + suffix;
        ClientSize = new Size(640, 360);
        BackColor = Color.FromArgb(31, 38, 58);
        DoubleBuffered = true;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using (var title = new Font("Microsoft YaHei", 26, FontStyle.Bold))
        using (var label = new Font("Microsoft YaHei", 20, FontStyle.Regular))
        using (var ink = new SolidBrush(Color.White))
        using (var fill = new SolidBrush(Color.FromArgb(53, 122, 214)))
        {
            e.Graphics.DrawString(settings ? "设置页面" : "主菜单", title, ink, 235, 54);
            e.Graphics.FillRectangle(fill, button);
            e.Graphics.DrawString(settings ? "返回" : "设置", label, ink, button.X + 48, button.Y + 10);
        }
    }

    protected override void OnMouseClick(MouseEventArgs e)
    {
        base.OnMouseClick(e);
        if (button.Contains(e.Location)) { settings = !settings; Invalidate(); }
    }

    [STAThread]
    public static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new VisionFixture(args.Length > 0 ? args[0] : "测试"));
    }
}
