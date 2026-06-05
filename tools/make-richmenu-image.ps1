# สร้างรูป Rich Menu 2500x1686 (6 ปุ่ม 2x3) สำหรับงานดูแลผู้เช่า
Add-Type -AssemblyName System.Drawing
$w = 2500; $h = 1686
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.FillRectangle([System.Drawing.Brushes]::White, 0, 0, $w, $h)

$cells = @(
  @{ x = 0;    y = 0;   w = 833; h = 843; hex = '#00897B'; t = "ข้อมูลห้อง" },
  @{ x = 833;  y = 0;   w = 833; h = 843; hex = '#F4511E'; t = "แจ้งซ่อม" },
  @{ x = 1666; y = 0;   w = 834; h = 843; hex = '#2E7D32'; t = "แจ้งชำระแล้ว" },
  @{ x = 0;    y = 843; w = 833; h = 843; hex = '#1565C0'; t = "สถานะชำระ" },
  @{ x = 833;  y = 843; w = 833; h = 843; hex = '#6D4C41'; t = "การแจ้งซ่อม" },
  @{ x = 1666; y = 843; w = 834; h = 843; hex = '#6A1B9A'; t = "ติดต่อเจ้าหน้าที่" }
)

$font = New-Object System.Drawing.Font("Leelawadee UI", 80, [System.Drawing.FontStyle]::Bold)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$white = [System.Drawing.Brushes]::White

foreach ($c in $cells) {
  $col = [System.Drawing.ColorTranslator]::FromHtml($c.hex)
  $br = New-Object System.Drawing.SolidBrush($col)
  $g.FillRectangle($br, ($c.x + 10), ($c.y + 10), ($c.w - 20), ($c.h - 20))
  $rect = New-Object System.Drawing.RectangleF($c.x, $c.y, $c.w, $c.h)
  $g.DrawString($c.t, $font, $white, $rect, $fmt)
  $br.Dispose()
}

$g.Dispose()
$out = Join-Path $PSScriptRoot 'richmenu.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved: $out"
