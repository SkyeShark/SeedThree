param(
  [ValidateSet('paperBirch', 'quakingAspen', 'americanSycamore', 'floweringDogwood', 'weepingWillow')]
  [string]$Species = 'paperBirch',
  [ValidateRange(1, 9999)]
  [int]$Seed = 1,
  [string]$EidoverseDir = ''
)

$ErrorActionPreference = 'Stop'
$seedThreeDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $EidoverseDir) {
  $EidoverseDir = Join-Path (Split-Path $seedThreeDir -Parent) 'eidoverse-video-prealpha-0.01'
}
$EidoverseDir = (Resolve-Path $EidoverseDir).Path
$renderer = Join-Path $EidoverseDir 'eidoverse\render_scene.mjs'
if (-not (Test-Path -LiteralPath $renderer)) {
  throw "Eidoverse renderer not found: $renderer"
}

$outputDir = Join-Path ([System.IO.Path]::GetTempPath()) 'seedthree-eidoverse-reference'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$slug = "$Species-seed$Seed"
$configPath = Join-Path $outputDir "$slug.json"
$outputPath = Join-Path $outputDir "$slug.mp4"
$sceneScript = Join-Path $seedThreeDir 'scripts\reference\eidoverse-tree-reference.js'

$config = [ordered]@{
  width = 960
  height = 960
  fps = 30
  duration = 0.8
  script = $sceneScript
  outputVideo = $outputPath
  skipPreflightQA = $true
  assets = @{}
}
$configJson = $config | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
  $configPath,
  $configJson,
  [System.Text.UTF8Encoding]::new($false)
)

$previousDir = $env:SEEDTHREE_DIR
$previousSpecies = $env:SEEDTHREE_SPECIES
$previousSeed = $env:SEEDTHREE_SEED
$env:SEEDTHREE_DIR = $seedThreeDir
$env:SEEDTHREE_SPECIES = $Species
$env:SEEDTHREE_SEED = [string]$Seed

Push-Location $EidoverseDir
try {
  & deno run --allow-all --unstable-webgpu --node-modules-dir=auto $renderer $configPath
  if ($LASTEXITCODE -ne 0) {
    throw "Eidoverse render failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
  $env:SEEDTHREE_DIR = $previousDir
  $env:SEEDTHREE_SPECIES = $previousSpecies
  $env:SEEDTHREE_SEED = $previousSeed
}

Write-Output $outputPath
Get-ChildItem -LiteralPath $outputDir -Filter "$slug`_probe*.png" |
  Sort-Object Name |
  Select-Object -ExpandProperty FullName
