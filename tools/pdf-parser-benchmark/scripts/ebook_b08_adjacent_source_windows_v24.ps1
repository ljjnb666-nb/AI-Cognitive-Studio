# Owner-only Windows source reconciliation; never upload book pixels or text to Actions.
$ErrorActionPreference = 'Stop'
try {
  $workspace = 'acs-b08-adjacent-v24'
  if ((git -C $workspace rev-parse HEAD).Trim() -ne $env:EXPECTED_SHA) { throw 'HEAD_MISMATCH' }
  $root='D:\ai-cognitive-pdf-benchmark-data'
  $parent=Join-Path $root 'semantic_gate\multibook_matrix_20261023'
  $py=Join-Path $root 'tool-env\docling-2.141.0\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $py -PathType Leaf)) { throw 'VERIFIED_PYTHON_MISSING' }
  $preserve=@(
    'multibook_native_24pages.private.json',
    'B08_p0064.private.png',
    'b08_b29_b31_source_hidpi_v17\b08_b29_b31_source_hidpi.v17.private.json',
    'b08_b29_b31_source_hidpi_v17\B08_p0064_FULL.private.png'
  )
  $before=@{}
  foreach($name in $preserve) {
    $p=Join-Path $parent $name
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw 'FROZEN_INPUT_MISSING' }
    $before[$p]=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
  }
  $env:HF_HUB_OFFLINE='1'
  $env:TRANSFORMERS_OFFLINE='1'
  $env:HTTP_PROXY='http://127.0.0.1:1'
  $env:HTTPS_PROXY='http://127.0.0.1:1'
  $env:ALL_PROXY='http://127.0.0.1:1'
  $script=Join-Path $workspace 'tools\pdf-parser-benchmark\scripts\ebook_b08_adjacent_source_review_v24.py'
  $manifest=Join-Path $workspace 'tools\pdf-parser-benchmark\corpus\ebook-20261022.manifest.json'
  $sub=Join-Path $parent 'b08_adjacent_source_review_v24'
  $mode=if (Test-Path -LiteralPath $sub) {'--audit-only'} else {'--write'}
  $create=@(& $py $script --private-root $root --manifest $manifest $mode 2>$null)
  if ($LASTEXITCODE -ne 0 -or @($create | Where-Object {$_ -match '^ACS_B08_V24=(PRIVATE_CREATED|PRIVATE_AUDIT_PASS)$'}).Count -ne 1) {
    throw 'SOURCE_CREATION_REJECTED'
  }
  $verify=@(& $py $script --private-root $root --manifest $manifest --audit-only 2>$null)
  if ($LASTEXITCODE -ne 0) { throw 'SOURCE_REPLAY_REJECTED' }
  foreach ($marker in @(
    'ACS_B08_V24=PRIVATE_AUDIT_PASS',
    'ACS_B08_V24_SOURCE_PAGES=3',
    'ACS_B08_V24_ADJACENT_PAGES=2',
    'ACS_B08_V24_FROZEN_V17=UNCHANGED',
    'ACS_B08_V24_BLEEDTHROUGH=UNDETERMINED',
    'ACS_B08_V24_GOLD=UNVERIFIED',
    'ACS_B08_V24_NEW_MODEL_CALLS=0')) {
    if (@($verify | Where-Object {$_ -ceq $marker}).Count -ne 1) { throw 'SOURCE_RECEIPT_REJECTED' }
  }
  foreach($name in $preserve) {
    $p=Join-Path $parent $name
    if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -cne $before[$p]) { throw 'FROZEN_INPUT_CHANGED' }
  }

  # Prepare a PRIVATE file handoff on D: only. Nothing is uploaded to Actions.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $out=Join-Path $root 'private-review-handoff'
  if (-not (Test-Path -LiteralPath $out -PathType Container)) {
    New-Item -ItemType Directory -Path $out -ErrorAction Stop | Out-Null
  }
  $zip=Join-Path $out 'ACS_B08_p63_p64_p65_相邻原页_v24.private.zip'
  $files=@('B08_p0063_SOURCE.private.png','B08_p0064_FULL.private.png',
            'B08_p0065_SOURCE.private.png','b08_adjacent_source.v24.private.json')
  if (-not (Test-Path -LiteralPath $zip)) {
    $stage=Join-Path $out ('acs-v24-stage-'+[Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
      foreach($name in $files) {
        Copy-Item -LiteralPath (Join-Path $sub $name) -Destination (Join-Path $stage $name) -ErrorAction Stop
      }
      [IO.Compression.ZipFile]::CreateFromDirectory($stage,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
    } finally {
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $archive=[IO.Compression.ZipFile]::OpenRead($zip)
  try {
    if ($archive.Entries.Count -ne $files.Count) { throw 'PRIVATE_HANDOFF_FILE_COUNT_CHANGED' }
    foreach($name in $files) {
      $entries=@($archive.Entries | Where-Object { $_.FullName -ceq $name })
      if ($entries.Count -ne 1) { throw 'PRIVATE_HANDOFF_ENTRY_CHANGED' }
      $content=[IO.MemoryStream]::new()
      try {
        $stream=$entries[0].Open()
        try { $stream.CopyTo($content) } finally { $stream.Dispose() }
        $bytes=$content.ToArray()
        $expectedBytes=[IO.File]::ReadAllBytes((Join-Path $sub $name))
        if ($entries[0].Length -gt 18874368) { throw 'PRIVATE_HANDOFF_ENTRY_TOO_LARGE' }
        $hasher=[Security.Cryptography.SHA256]::Create()
        try {
          $got=[BitConverter]::ToString($hasher.ComputeHash([byte[]]$bytes)).Replace('-','')
          $expect=[BitConverter]::ToString($hasher.ComputeHash([byte[]]$expectedBytes)).Replace('-','')
          if ($got -cne $expect) {throw 'PRIVATE_HANDOFF_BYTES_CHANGED'}
        } finally {$hasher.Dispose()}
      } finally { $content.Dispose() }
    }
  } finally {$archive.Dispose()}
  Write-Output 'ACS_B08_V24_WINDOWS=PRIVATE_AUDIT_PASS'
  Write-Output 'ACS_B08_V24_PRIVATE_HANDOFF=READY_ON_D_DRIVE'
  Write-Output 'ACS_B08_V24_SOURCE_PAGES=3'
  Write-Output 'ACS_B08_V24_FROZEN_INPUTS=UNCHANGED'
  Write-Output 'ACS_B08_V24_BLEEDTHROUGH=UNDETERMINED'
  Write-Output 'ACS_B08_V24_MODEL_CALLS=0'
} catch {
  Write-Output 'ACS_B08_V24_WINDOWS=REJECTED'
  exit 2
}
