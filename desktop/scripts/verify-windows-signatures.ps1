$ErrorActionPreference = "Stop"

if ($env:BIODESIGN_PRODUCTION_RELEASE -cne "1") {
  throw "Signature verification is only valid for a production release build."
}
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_SIGNING_SUBJECT)) {
  throw "WINDOWS_SIGNING_SUBJECT is required for signature verification."
}

$packageRoot = Join-Path $PWD "out/BioDesign-win32-x64"
$setupPath = Join-Path $PWD "out/make/squirrel.windows/x64/BioDesign-Setup.exe"
$package = Get-Content package.json -Raw | ConvertFrom-Json
$nupkgPath = Join-Path $PWD "out/make/squirrel.windows/x64/BioDesign-$($package.version)-full.nupkg"
if (!(Test-Path -LiteralPath $packageRoot -PathType Container)) {
  throw "The packaged Windows application is missing."
}
if (!(Test-Path -LiteralPath $setupPath -PathType Leaf)) {
  throw "The Windows installer is missing."
}
if (!(Test-Path -LiteralPath $nupkgPath -PathType Leaf)) {
  throw "The full Windows update package is missing."
}

$nupkgExtraction = Join-Path $env:RUNNER_TEMP "biodesign-signature-audit"
if (Test-Path -LiteralPath $nupkgExtraction) {
  Remove-Item -LiteralPath $nupkgExtraction -Recurse -Force
}
[IO.Directory]::CreateDirectory($nupkgExtraction) | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($nupkgPath, $nupkgExtraction)

try {
  $signable = @(
    Get-ChildItem -LiteralPath $packageRoot -Recurse -File
    Get-ChildItem -LiteralPath $nupkgExtraction -Recurse -File
    Get-Item -LiteralPath $setupPath
  ) | Where-Object { $_.Extension -in @(".exe", ".dll", ".node", ".sys", ".scr", ".msi") } |
    Sort-Object -Property FullName -Unique

  if ($signable.Count -eq 0) {
    throw "No Windows distributable binaries were found for signature verification."
  }

  foreach ($file in $signable) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne "Valid") {
      throw "A distributable binary does not have a valid Authenticode signature: $($file.Name)."
    }
    if ($null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notlike "*$($env:WINDOWS_SIGNING_SUBJECT)*") {
      throw "A distributable binary was not signed by the required BioDesign publisher: $($file.Name)."
    }
    if ($null -eq $signature.TimeStamperCertificate) {
      throw "A distributable binary does not have a trusted timestamp: $($file.Name)."
    }
  }

  Write-Host "Validated Authenticode publisher identity and timestamps for $($signable.Count) distributable binaries."
} finally {
  Remove-Item -LiteralPath $nupkgExtraction -Recurse -Force
}
