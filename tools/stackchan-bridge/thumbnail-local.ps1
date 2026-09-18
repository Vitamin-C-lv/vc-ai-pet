param(
    [Parameter(Mandatory = $true)][string]$InputFile,
    [Parameter(Mandatory = $true)][string]$OutputFile
)

Add-Type -AssemblyName System.Drawing
$source = [Drawing.Image]::FromFile($InputFile)
try {
    $scale = [Math]::Min(256.0 / $source.Width, 256.0 / $source.Height)
    $width = [Math]::Max(1, [int][Math]::Round($source.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($source.Height * $scale))
    $thumbnail = New-Object Drawing.Bitmap $width, $height
    try {
        $graphics = [Drawing.Graphics]::FromImage($thumbnail)
        try {
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($source, 0, 0, $width, $height)
        } finally {
            $graphics.Dispose()
        }
        $thumbnail.Save($OutputFile, [Drawing.Imaging.ImageFormat]::Jpeg)
    } finally {
        $thumbnail.Dispose()
    }
} finally {
    $source.Dispose()
}
