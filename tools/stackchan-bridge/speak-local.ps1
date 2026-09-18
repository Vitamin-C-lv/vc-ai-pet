param([Parameter(Mandatory=$true)][string]$TextFile,[Parameter(Mandatory=$true)][string]$OutputFile)
Add-Type -AssemblyName System.Speech
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speech.SelectVoice('Microsoft Huihui Desktop')
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
    $stream = [IO.File]::Create($OutputFile)
    try {
        $speech.SetOutputToAudioStream($stream,$format)
        $speech.Speak([IO.File]::ReadAllText($TextFile,[Text.Encoding]::UTF8))
    } finally { $speech.SetOutputToNull(); $stream.Dispose() }
} finally { $speech.Dispose() }