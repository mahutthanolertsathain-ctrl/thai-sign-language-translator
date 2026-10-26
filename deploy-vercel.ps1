$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$site = [System.IO.Path]::GetFullPath((Join-Path $root 'vercel-site'))
$sitePrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $site.StartsWith($sitePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The Vercel staging directory must stay inside the project folder.'
}

New-Item -ItemType Directory -Path $site -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'index.html') -Destination (Join-Path $site 'index.html') -Force
Copy-Item -LiteralPath (Join-Path $root 'vercel.json') -Destination (Join-Path $site 'vercel.json') -Force

$copyArgs = @((Join-Path $root 'web-static'), (Join-Path $site 'web-static'), '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
& robocopy @copyArgs
if ($LASTEXITCODE -gt 7) {
  throw "Failed to sync web-static into the Vercel staging directory (robocopy exit code $LASTEXITCODE)."
}

& npx vercel deploy --cwd $site --prod
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
