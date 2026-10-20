using System.Globalization;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.UI;

namespace NetInventory.Desktop;

/// <summary>
/// Visual vocabulary of the NetInventory web panel (dark zinc surfaces, green primary, pill buttons,
/// 12px rounded cards with a faint ring, muted 12px labels and large values with small units),
/// so the Windows app and its installer read as the same product.
/// </summary>
internal static class PanelTheme
{
    internal static readonly Color Background = Color.FromArgb(255, 0x18, 0x18, 0x1B);
    internal static readonly Color Sidebar = Color.FromArgb(255, 0x13, 0x13, 0x16);
    internal static readonly Color Surface = Color.FromArgb(255, 0x27, 0x27, 0x2A);
    internal static readonly Color InputSurface = Color.FromArgb(255, 0x2E, 0x2E, 0x33);
    internal static readonly Color Ring = Color.FromArgb(0x1A, 0xFF, 0xFF, 0xFF);
    internal static readonly Color Track = Color.FromArgb(255, 0x36, 0x36, 0x3C);
    internal static readonly Color Hover = Color.FromArgb(255, 0x2A, 0x2A, 0x2F);
    internal static readonly Color Foreground = Color.FromArgb(255, 0xFA, 0xFA, 0xFA);
    internal static readonly Color Muted = Color.FromArgb(255, 0x9F, 0x9F, 0xA9);
    internal static readonly Color Primary = Color.FromArgb(255, 0x00, 0xC9, 0x50);
    internal static readonly Color PrimaryText = Color.FromArgb(255, 0x0A, 0x0A, 0x0A);
    internal static readonly Color Amber = Color.FromArgb(255, 0xFE, 0x9A, 0x00);
    internal static readonly Color Danger = Color.FromArgb(255, 0xFF, 0x64, 0x67);
    internal static readonly Color OnlineText = Color.FromArgb(255, 0x00, 0xD4, 0x92);
    internal static readonly Color OnlineBack = Color.FromArgb(255, 0x00, 0x2C, 0x22);
    internal static readonly Color OnlineRing = Color.FromArgb(255, 0x00, 0x4F, 0x3B);
    internal static readonly Color WarnText = Color.FromArgb(255, 0xFF, 0xB9, 0x00);
    internal static readonly Color WarnBack = Color.FromArgb(255, 0x46, 0x19, 0x01);
    internal static readonly Color WarnRing = Color.FromArgb(255, 0x7B, 0x33, 0x06);
    internal static readonly CultureInfo Br = CultureInfo.GetCultureInfo("pt-BR");
    internal static readonly FontFamily Mono = new("Cascadia Mono, Consolas");

    internal static SolidColorBrush Brush(Color color) => new(color);

    internal static TextBlock Text(string text, double size, Color color, Windows.UI.Text.FontWeight? weight = null) => new()
    {
        Text = text, FontSize = size, Foreground = Brush(color), TextWrapping = TextWrapping.Wrap, FontWeight = weight ?? FontWeights.Normal,
    };

    internal static FontIcon Icon(string glyph, double size, Color color) => new() { Glyph = glyph, FontSize = size, Foreground = Brush(color) };

    internal static Image Logo(double size)
    {
        var logo = new Image { Source = new BitmapImage(new Uri("ms-appx:///Assets/logo.png")), Width = size, Height = size, Stretch = Stretch.Uniform, VerticalAlignment = VerticalAlignment.Center };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(logo, "Logo do NetInventory");
        return logo;
    }

    /// <summary>Card: title, optional description and body, as the panel's data-slot="card".</summary>
    internal static (Border Card, StackPanel Body) Card(string title, string? description = null, UIElement? action = null, string? glyph = null, Color? glyphColor = null)
    {
        var body = new StackPanel { Spacing = 16 };
        var header = new Grid { ColumnSpacing = 12 };
        header.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        var titles = new StackPanel { Spacing = 4 };
        var titleRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        if (glyph is not null) titleRow.Children.Add(Icon(glyph, 14, glyphColor ?? Primary));
        titleRow.Children.Add(Text(title, 16, Foreground, FontWeights.SemiBold));
        titles.Children.Add(titleRow);
        if (description is not null) titles.Children.Add(Text(description, 14, Muted));
        header.Children.Add(titles);
        if (action is not null) { Grid.SetColumn((FrameworkElement)action, 1); header.Children.Add(action); }
        body.Children.Add(header);
        var card = new Border
        {
            Child = body, Padding = new Thickness(16), CornerRadius = new CornerRadius(12), Background = Brush(Surface),
            BorderBrush = Brush(Ring), BorderThickness = new Thickness(1),
        };
        return (card, body);
    }

    /// <summary>Label above value, as the panel's "Detalhes" grid.</summary>
    internal static StackPanel Field(string label, string? value, string? note = null, bool mono = false)
    {
        var panel = new StackPanel { Spacing = 2 };
        panel.Children.Add(Text(label, 12, Muted));
        var text = Text(string.IsNullOrWhiteSpace(value) ? "Indisponível" : value, 14, Foreground);
        text.IsTextSelectionEnabled = true;
        if (mono) text.FontFamily = Mono;
        panel.Children.Add(text);
        if (!string.IsNullOrEmpty(note)) panel.Children.Add(Text(note, 12, Muted));
        return panel;
    }

    /// <summary>Large number with a small unit, as the panel's hardware card ("3 %", "60 °C").</summary>
    internal static StackPanel Metric(string label, string value, string? unit, string? note = null, double? percent = null, Color? accent = null)
    {
        var panel = new StackPanel { Spacing = 4 };
        panel.Children.Add(Text(label, 12, Muted));
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 3 };
        line.Children.Add(Text(value, 24, accent ?? Foreground, FontWeights.SemiBold));
        if (!string.IsNullOrEmpty(unit))
        {
            var small = Text(unit, 12, Muted);
            small.VerticalAlignment = VerticalAlignment.Bottom; small.Margin = new Thickness(0, 0, 0, 4);
            line.Children.Add(small);
        }
        panel.Children.Add(line);
        if (percent is { } p && double.IsFinite(p))
        {
            var fill = p >= 90 ? Danger : p >= 75 ? Amber : Primary;
            panel.Children.Add(new ProgressBar
            {
                Value = Math.Clamp(p, 0, 100), Maximum = 100, Height = 6, MinHeight = 6, CornerRadius = new CornerRadius(3),
                Foreground = Brush(fill), Background = Brush(Track),
            });
        }
        if (note is not null) panel.Children.Add(Text(note, 12, Muted));
        return panel;
    }

    /// <summary>Fixed-column grid; each row is as tall as its tallest cell (nothing is clipped).</summary>
    internal static Grid Columns(int columns, params UIElement[] items)
    {
        var grid = new Grid { ColumnSpacing = 24, RowSpacing = 16 };
        for (var c = 0; c < columns; c++) grid.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        for (var r = 0; r < (items.Length + columns - 1) / columns; r++) grid.RowDefinitions.Add(new() { Height = GridLength.Auto });
        for (var i = 0; i < items.Length; i++) { Grid.SetRow((FrameworkElement)items[i], i / columns); Grid.SetColumn((FrameworkElement)items[i], i % columns); grid.Children.Add(items[i]); }
        return grid;
    }

    // Flat template matching the panel's button (h-8, px-2.5, gap-1.5, text-sm font-medium, rounded-full):
    // no system elevation border or gradient; hover dims like hover:bg-primary/80, press nudges 1px, disabled at 50%.
    private static readonly Lazy<ControlTemplate> FlatButton = new(() => (ControlTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load(
        """
        <ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="Button">
          <Grid x:Name="Root" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Height="32" Padding="{TemplateBinding Padding}"
                Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="16">
            <Grid.RenderTransform><TranslateTransform x:Name="Nudge" /></Grid.RenderTransform>
            <VisualStateManager.VisualStateGroups>
              <VisualStateGroup x:Name="CommonStates">
                <VisualState x:Name="Normal" />
                <VisualState x:Name="PointerOver"><VisualState.Setters><Setter Target="Root.Opacity" Value="0.85" /></VisualState.Setters></VisualState>
                <VisualState x:Name="Pressed"><VisualState.Setters><Setter Target="Root.Opacity" Value="0.8" /><Setter Target="Nudge.Y" Value="1" /></VisualState.Setters></VisualState>
                <VisualState x:Name="Disabled"><VisualState.Setters><Setter Target="Root.Opacity" Value="0.5" /></VisualState.Setters></VisualState>
              </VisualStateGroup>
            </VisualStateManager.VisualStateGroups>
            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Content="{TemplateBinding Content}" />
          </Grid>
        </ControlTemplate>
        """));

    /// <summary>Pill button: primary (green, dark text) or outline (faint border, near-transparent fill), optional 16px icon.</summary>
    internal static Button Pill(string text, bool primary, string? glyph = null)
    {
        var ink = primary ? PrimaryText : Foreground;
        var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        if (glyph is not null) { var icon = Icon(glyph, 14, ink); icon.VerticalAlignment = VerticalAlignment.Center; content.Children.Add(icon); }
        content.Children.Add(new TextBlock { Text = text, FontSize = 14, FontWeight = FontWeights.Medium, Foreground = Brush(ink), VerticalAlignment = VerticalAlignment.Center });
        return new Button
        {
            Template = FlatButton.Value, Content = content, Padding = new Thickness(10, 0, 10, 0), VerticalAlignment = VerticalAlignment.Center,
            Background = Brush(primary ? Primary : Color.FromArgb(0x0C, 0xFF, 0xFF, 0xFF)),
            BorderBrush = Brush(primary ? Primary : Color.FromArgb(0x26, 0xFF, 0xFF, 0xFF)), BorderThickness = new Thickness(1),
        };
    }

    internal static Border Badge(string text, Color foreground, Color background, Color ring)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5 };
        line.Children.Add(new Microsoft.UI.Xaml.Shapes.Ellipse { Width = 6, Height = 6, Fill = Brush(foreground), VerticalAlignment = VerticalAlignment.Center });
        line.Children.Add(Text(text, 12, foreground));
        // Fixed 22px height with a matching 11px radius: a true pill like the panel's badge, not an ellipse.
        line.VerticalAlignment = VerticalAlignment.Center;
        return new Border
        {
            Child = line, Height = 22, CornerRadius = new CornerRadius(11), Padding = new Thickness(10, 0, 10, 0), BorderThickness = new Thickness(1),
            Background = Brush(background), BorderBrush = Brush(ring), VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Left,
        };
    }

    /// <summary>Status shown exactly like the primary Pill button (32px, rounded-full, green fill, 14px medium dark text), with a dot in place of the icon.</summary>
    internal static Border StatusPill(string text)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, VerticalAlignment = VerticalAlignment.Center };
        line.Children.Add(new Microsoft.UI.Xaml.Shapes.Ellipse { Width = 8, Height = 8, Fill = Brush(PrimaryText), VerticalAlignment = VerticalAlignment.Center });
        line.Children.Add(new TextBlock { Text = text, FontSize = 14, FontWeight = FontWeights.Medium, Foreground = Brush(PrimaryText), VerticalAlignment = VerticalAlignment.Center });
        return new Border
        {
            Child = line, Height = 32, CornerRadius = new CornerRadius(16), Padding = new Thickness(10, 0, 10, 0), BorderThickness = new Thickness(1),
            Background = Brush(Primary), BorderBrush = Brush(Primary), VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Left,
        };
    }

    internal static TextBox Input(string header, string text, string placeholder) => new()
    {
        Header = Text(header, 12, Muted), Text = text, PlaceholderText = placeholder, CornerRadius = new CornerRadius(8),
        Background = Brush(InputSurface), BorderBrush = Brush(Ring), Foreground = Brush(Foreground),
    };

    /// <summary>Table as in the panel: muted header, rows separated by faint lines, optional right-aligned last column.</summary>
    internal static Grid Table(string[] headers, IEnumerable<string[]> rows, double[]? weights = null, bool alignLastRight = false, int monoColumn = -1)
    {
        var grid = new Grid();
        for (var c = 0; c < headers.Length; c++) grid.ColumnDefinitions.Add(new() { Width = new GridLength(weights?[c] ?? 1, GridUnitType.Star) });
        var all = rows.ToList();
        for (var r = 0; r <= all.Count; r++) grid.RowDefinitions.Add(new() { Height = GridLength.Auto });
        for (var r = 0; r <= all.Count; r++)
        {
            var line = new Border { BorderBrush = Brush(Ring), BorderThickness = new Thickness(0, 0, 0, r == all.Count ? 0 : 1) };
            Grid.SetRow(line, r); Grid.SetColumnSpan(line, headers.Length); grid.Children.Add(line);
            for (var c = 0; c < headers.Length; c++)
            {
                var header = r == 0;
                var value = header ? headers[c] : all[r - 1][c];
                var text = Text(value, header ? 12 : 14, header ? Muted : Foreground, header ? FontWeights.SemiBold : null);
                text.Margin = new Thickness(c == 0 ? 0 : 8, 10, 8, 10);
                text.IsTextSelectionEnabled = !header;
                if (!header && c == monoColumn) text.FontFamily = Mono;
                if (alignLastRight && c == headers.Length - 1) { text.HorizontalAlignment = HorizontalAlignment.Right; text.TextAlignment = TextAlignment.Right; }
                Grid.SetRow(text, r); Grid.SetColumn(text, c); grid.Children.Add(text);
            }
        }
        return grid;
    }

    internal static void TitleBar(Window window, string title)
    {
        window.Title = title;
        if (window.AppWindow.TitleBar is { } bar)
        {
            bar.BackgroundColor = Sidebar; bar.InactiveBackgroundColor = Sidebar; bar.ButtonBackgroundColor = Sidebar; bar.ButtonInactiveBackgroundColor = Sidebar;
            bar.ForegroundColor = Foreground; bar.ButtonForegroundColor = Foreground; bar.InactiveForegroundColor = Muted; bar.ButtonHoverBackgroundColor = Hover;
        }
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "netinventory.ico");
        if (File.Exists(icon)) window.AppWindow.SetIcon(icon);
    }

    internal static string Bytes(ulong value)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        double size = value; var unit = 0;
        while (size >= 1024 && unit < units.Length - 1) { size /= 1024; unit++; }
        return size.ToString(unit >= 3 ? "0.0" : "0", Br) + " " + units[unit];
    }

    internal static string Age(DateTimeOffset time)
    {
        var age = DateTimeOffset.UtcNow - time;
        if (age.TotalSeconds < 0) age = TimeSpan.Zero;
        return age.TotalSeconds < 60 ? $"há {(int)age.TotalSeconds} s" : age.TotalMinutes < 60 ? $"há {(int)age.TotalMinutes} min"
            : age.TotalHours < 24 ? $"há {(int)age.TotalHours} h" : time.ToLocalTime().ToString("dd/MM/yyyy HH:mm", Br);
    }

    internal static string Uptime(long seconds)
    {
        if (seconds < 0) return "Indisponível";
        var time = TimeSpan.FromSeconds(seconds);
        return time.TotalDays >= 1 ? $"{(int)time.TotalDays}d {time.Hours}h {time.Minutes}m" : time.TotalHours >= 1 ? $"{time.Hours}h {time.Minutes}m" : $"{time.Minutes}m";
    }
}
