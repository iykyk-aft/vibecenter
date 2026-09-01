# Generates web/assets/vibe.ico and vibe.png (neon lightning badge) with no external tools.
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'web\assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null
$size = 256

$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# rounded-rect background with a purple -> teal gradient
$rect = New-Object System.Drawing.Rectangle(10, 10, ($size - 20), ($size - 20))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 56
$path.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
$path.AddArc($rect.Right - $r, $rect.Y, $r, $r, 270, 90)
$path.AddArc($rect.Right - $r, $rect.Bottom - $r, $r, $r, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $r, $r, $r, 90, 90)
$path.CloseFigure()
$c1 = [System.Drawing.Color]::FromArgb(124, 92, 255)
$c2 = [System.Drawing.Color]::FromArgb(24, 224, 216)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 50)
$g.FillPath($brush, $path)

# lightning bolt
$pts = @(
  (New-Object System.Drawing.PointF(152, 44)),
  (New-Object System.Drawing.PointF(92, 146)),
  (New-Object System.Drawing.PointF(132, 146)),
  (New-Object System.Drawing.PointF(104, 214)),
  (New-Object System.Drawing.PointF(176, 104)),
  (New-Object System.Drawing.PointF(132, 104))
)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(245, 246, 255))
$g.FillPolygon($white, $pts)
$g.Dispose()

# PNG
$png = Join-Path $assets 'vibe.png'
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)

# ICO embedding the 256px PNG (Vista+ supports PNG-compressed icon entries)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $ms.ToArray()
$icoPath = Join-Path $assets 'vibe.ico'
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)      # reserved, type, count
$bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0)  # w,h(=256),colors,reserved
$bw.Write([UInt16]1); $bw.Write([UInt16]32)                          # planes, bpp
$bw.Write([UInt32]$pngBytes.Length); $bw.Write([UInt32]22)           # size, offset
$bw.Write($pngBytes); $bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())

Write-Output "Icon written: $icoPath"

# --- full-bleed opaque icons: iOS apple-touch-icon + Android maskable ---
# The transparent inset corners above are INTENTIONAL for vibe.ico (Windows
# taskbar) and the browser favicon. iOS/Android home-screen icons must be
# square, opaque and full-bleed: iOS applies its own squircle mask (which would
# double-round the art and composite the transparent corners onto black), and
# Android maskable crops INTO the icon.
function New-FullBleedIcon([int]$sz, [string]$outPath) {
  $g1 = [System.Drawing.Color]::FromArgb(124, 92, 255)
  $g2 = [System.Drawing.Color]::FromArgb(24, 224, 216)
  $b  = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gg = [System.Drawing.Graphics]::FromImage($b)
  # Opaque base FIRST: any edge blending then composites onto solid pixels
  # instead of onto transparency (which is what left alpha=64 corners).
  $gg.Clear($g1)
  # A rectangle needs no antialiasing, and AA is exactly what bled the edges.
  $gg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
  $full = New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)
  $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush($full, $g1, $g2, 50)
  $br.WrapMode = [System.Drawing.Drawing2D.WrapMode]::TileFlipXY
  $gg.FillRectangle($br, $full)   # edge to edge, fully opaque
  # AA back on for the bolt only.
  $gg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $s = $sz / 256.0                # the bolt is authored in 256-space; scale it
  $bolt = @(
    (New-Object System.Drawing.PointF((152*$s), (44*$s))),
    (New-Object System.Drawing.PointF((92*$s),  (146*$s))),
    (New-Object System.Drawing.PointF((132*$s), (146*$s))),
    (New-Object System.Drawing.PointF((104*$s), (214*$s))),
    (New-Object System.Drawing.PointF((176*$s), (104*$s))),
    (New-Object System.Drawing.PointF((132*$s), (104*$s)))
  )
  $wb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(245, 246, 255))
  $gg.FillPolygon($wb, $bolt)
  $gg.Dispose()
  $b.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
  Write-Output "Icon written: $outPath"
}
New-FullBleedIcon 180 (Join-Path $assets 'apple-touch-icon-180.png')
New-FullBleedIcon 512 (Join-Path $assets 'vibe-maskable-512.png')
