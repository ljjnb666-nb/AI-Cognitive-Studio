# Owner-only offline proof. Never upload source pages or transcripts to CI.
$ErrorActionPreference = 'Stop'
try {
  $base = 'acs-threebook-v17'
  if ((git -C $base rev-parse HEAD).Trim() -ne $env:EXPECTED_SHA) { throw 'HEAD_CHANGED' }
  $root = 'D:\ai-cognitive-pdf-benchmark-data'
  $dir = Join-Path $root 'semantic_gate\multibook_matrix_20261023'
  $python = Join-Path $root 'tool-env\docling-2.141.0\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'PYTHON_NOT_FOUND' }
  $tracked = @('multibook_native_24pages.private.json',
    'B08_p0064.private.png','B29_p0072.private.png','B31_p0126.private.png',
    'docling_native_single_pages\B08_p0064.private.pdf',
    'docling_native_single_pages\B29_p0072.private.pdf',
    'docling_native_single_pages\B31_p0126.private.pdf')
  $before = @{}
  foreach ($item in $tracked) {
    $path = Join-Path $dir $item
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'SOURCE_NOT_FOUND' }
    $before[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
  }
  $env:HF_HUB_OFFLINE='1'
  $env:TRANSFORMERS_OFFLINE='1'
  $env:HTTP_PROXY='http://127.0.0.1:1'
  $env:HTTPS_PROXY='http://127.0.0.1:1'
  $env:ALL_PROXY='http://127.0.0.1:1'
  $script = Join-Path $base 'tools\pdf-parser-benchmark\scripts\ebook_threebook_source_hidpi_v17.py'
  $manifest = Join-Path $base 'tools\pdf-parser-benchmark\corpus\ebook-20261022.manifest.json'
  $dest = Join-Path $dir 'b08_b29_b31_source_hidpi_v17'
  $mode = if (Test-Path -LiteralPath $dest) { '--audit-only' } else { '--write' }
  $result = @(& $python $script --private-root $root --manifest $manifest $mode 2>$null)
  if ($LASTEXITCODE -ne 0 -or @($result | Where-Object {
    $_ -match '^ACS_THREEBOOK_HIDPI_V17=(PRIVATE_CREATED|PRIVATE_AUDIT_PASS)$'
  }).Count -ne 1) { throw 'CREATE_OR_AUDIT_REJECTED' }
  $replay = @(& $python $script --private-root $root --manifest $manifest --audit-only 2>$null)
  if ($LASTEXITCODE -ne 0) { throw 'REPLAY_REJECTED' }
  foreach ($expected in @('ACS_THREEBOOK_HIDPI_V17=PRIVATE_AUDIT_PASS',
    'ACS_THREEBOOK_HIDPI_V17_PAGES=3',
    'ACS_THREEBOOK_HIDPI_V17_TILES=27',
    'ACS_THREEBOOK_HIDPI_V17_GOLD=UNVERIFIED',
    'ACS_THREEBOOK_HIDPI_V17_MODEL_CALLS=0')) {
    if (@($replay | Where-Object { $_ -eq $expected }).Count -ne 1) { throw 'REPLAY_RECEIPT_REJECTED' }
  }
  foreach ($item in $tracked) {
    $path = Join-Path $dir $item
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $before[$path]) { throw 'FROZEN_SOURCE_CHANGED' }
  }
  Write-Output 'ACS_THREEBOOK_HIDPI_V17_WINDOWS=PRIVATE_AUDIT_PASS'
  Write-Output 'ACS_THREEBOOK_HIDPI_V17_PAGES=3'
  Write-Output 'ACS_THREEBOOK_HIDPI_V17_TILES=27'
  Write-Output 'ACS_THREEBOOK_HIDPI_V17_FROZEN_INPUTS=UNCHANGED'
  Write-Output 'ACS_THREEBOOK_HIDPI_V17_GOLD=UNVERIFIED'
  Write-Output 'ACS_THREEBOOK_HIDPI_V17_MODEL_CALLS=0'
} catch {
  Write-Output 'ACS_THREEBOOK_HIDPI_V17_WINDOWS=REJECTED'
  exit 2
}
