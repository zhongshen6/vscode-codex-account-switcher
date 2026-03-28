$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageJsonPath = Join-Path $root "package.json"
$package = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json

$stageRoot = Join-Path $root ".vsix-staging"
$extensionFolder = Join-Path $stageRoot "extension"
$vsixName = "$($package.name)-$($package.version).vsix"
$vsixPath = Join-Path $root $vsixName
$zipPath = Join-Path $root "$($package.name)-$($package.version).zip"

if (Test-Path -LiteralPath $stageRoot) {
  Remove-Item -LiteralPath $stageRoot -Recurse -Force
}

if (Test-Path -LiteralPath $vsixPath) {
  Remove-Item -LiteralPath $vsixPath -Force
}

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
New-Item -ItemType Directory -Path $extensionFolder -Force | Out-Null

$filesToCopy = @(
  "package.json",
  "extension.js",
  "codexPatch.js",
  "README.md"
)

foreach ($file in $filesToCopy) {
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $extensionFolder $file) -Force
}

$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="xml" ContentType="text/xml" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
'@
Set-Content -LiteralPath (Join-Path $stageRoot "[Content_Types].xml") -Value $contentTypes -Encoding UTF8

$description = [System.Security.SecurityElement]::Escape([string]$package.description)
$displayName = [System.Security.SecurityElement]::Escape([string]$package.displayName)
$publisher = [System.Security.SecurityElement]::Escape([string]$package.publisher)
$engine = [System.Security.SecurityElement]::Escape([string]$package.engines.vscode)
$id = [System.Security.SecurityElement]::Escape("$($package.publisher).$($package.name)")
$version = [System.Security.SecurityElement]::Escape([string]$package.version)
$categories = [System.Security.SecurityElement]::Escape(([string[]]$package.categories) -join ",")

$vsixManifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$id" Version="$version" Publisher="$publisher" />
    <DisplayName>$displayName</DisplayName>
    <Description xml:space="preserve">$description</Description>
    <Categories>$categories</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$engine" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" />
  </Assets>
</PackageManifest>
"@
Set-Content -LiteralPath (Join-Path $stageRoot "extension.vsixmanifest") -Value $vsixManifest -Encoding UTF8

Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zipPath -Force
Move-Item -LiteralPath $zipPath -Destination $vsixPath -Force

Write-Output "Created VSIX: $vsixPath"
