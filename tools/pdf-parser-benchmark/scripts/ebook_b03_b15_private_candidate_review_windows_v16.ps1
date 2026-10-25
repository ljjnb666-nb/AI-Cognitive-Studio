# Owner-only, no-network, SHA-pinned review packet for exactly 3 completed/1 unknown.
$ErrorActionPreference='Stop'
try {
    $checkout=(Resolve-Path -LiteralPath 'acs-v16-review').Path
    if ((git -C $checkout rev-parse HEAD).Trim() -ne $env:EXPECTED_SHA) {
        throw 'SHA_MISMATCH'
    }
    $root='D:\ai-cognitive-pdf-benchmark-data'
    $dir=Join-Path $root 'semantic_gate\multibook_matrix_20261023'
    $py=Join-Path $root 'tool-env\docling-2.141.0\Scripts\python.exe'
    $v13=Join-Path $checkout 'tools\pdf-parser-benchmark\scripts\ebook_b03_b15_source_hidpi_v13.py'
    $v16=Join-Path $checkout 'tools\pdf-parser-benchmark\scripts\ebook_b03_b15_private_candidate_review_v16.py'
    $manifest=Join-Path $checkout 'tools\pdf-parser-benchmark\corpus\ebook-20261022.manifest.json'
    foreach ($path in @($py,$v13,$v16,$manifest)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'REQUIRED_FILE_MISSING' }
    }
    $v13Folder=Join-Path $dir 'b03_b15_source_hidpi_v13'
    $v14Folder=Join-Path $dir 'b03_b15_blind_visual_triage_v14'
    $frozen=@(
        (Join-Path $v13Folder 'b03_b15_hidpi_source_review.v13.private.json'),
        (Join-Path $v14Folder 'B03_p0067_R1C2.attempt.private.json'),
        (Join-Path $v14Folder 'B03_p0067_R1C2.candidate.private.json'),
        (Join-Path $v14Folder 'B03_p0067_R1C3.attempt.private.json'),
        (Join-Path $v14Folder 'B03_p0067_R1C3.candidate.private.json'),
        (Join-Path $v14Folder 'B03_p0067_R2C2.attempt.private.json'),
        (Join-Path $v14Folder 'B15_p0109_R3C2.attempt.private.json'),
        (Join-Path $v14Folder 'B15_p0109_R3C2.candidate.private.json')
    )
    foreach ($book in @('B03','B15')) {
        $page=if ($book -eq 'B03') {'0067'} else {'0109'}
        for ($row=1; $row -le 3; $row++) {
            for ($col=1; $col -le 3; $col++) {
                $frozen+=Join-Path $v13Folder ("{0}_p{1}_R{2}C{3}.private.png" -f $book,$page,$row,$col)
            }
        }
    }
    $before=@{}
    foreach ($path in $frozen) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'FROZEN_FILE_MISSING' }
        $before[$path]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    }
    $env:HTTP_PROXY='http://127.0.0.1:1'
    $env:HTTPS_PROXY='http://127.0.0.1:1'
    $env:ALL_PROXY='http://127.0.0.1:1'
    $env:HF_HUB_OFFLINE='1'
    $env:TRANSFORMERS_OFFLINE='1'
    $source=@(& $py $v13 --private-root $root --manifest $manifest --audit-only 2>$null)
    if ($LASTEXITCODE -ne 0 -or
        @($source | Where-Object { $_ -eq 'ACS_HIDPI_SOURCE=PRIVATE_AUDIT_PASS' }).Count -ne 1) {
        throw 'V13_SOURCE_REPLAY_REJECTED'
    }
    Write-Output 'ACS_V16_V13_REAL_SOURCE_REPLAY=PASS'
    $outputFolder=Join-Path $dir 'b03_b15_candidate_source_review_v16'
    $mode=if (Test-Path -LiteralPath $outputFolder) {'--audit-only'} else {'--write'}
    $one=@(& $py $v16 --private-root $root $mode 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'V16_PRIVATE_PACKET_REJECTED' }
    if (@($one | Where-Object { $_ -match '^ACS_V16_REVIEW=(PRIVATE_CREATED|PRIVATE_AUDIT_PASS)$' }).Count -ne 1) {
        throw 'V16_PACKET_RECEIPT_INVALID'
    }
    $audit=@(& $py $v16 --private-root $root --audit-only 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'V16_REPLAY_REJECTED' }
    foreach ($expected in @('ACS_V16_REVIEW=PRIVATE_AUDIT_PASS',
                             'ACS_V16_MODEL_CANDIDATES=3',
                             'ACS_V16_UNKNOWN_CHARGE_FENCES=1',
                             'ACS_V16_NEW_MODEL_CALLS=0',
                             'ACS_V16_GOLD=NOT_APPROVED')) {
        if (@($audit | Where-Object { $_ -eq $expected }).Count -ne 1) {
            throw 'V16_REPLAY_COUNTS_INVALID'
        }
    }
    foreach ($path in $frozen) {
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $before[$path]) {
            throw 'FROZEN_INPUT_MODIFIED'
        }
    }
    Write-Output 'ACS_V16_WINDOWS=PRIVATE_AUDIT_PASS'
    Write-Output 'ACS_V16_MODEL_CANDIDATES=3'
    Write-Output 'ACS_V16_UNKNOWN_CHARGE_FENCES=1'
    Write-Output 'ACS_V16_FROZEN_INPUTS=UNCHANGED'
    Write-Output 'ACS_V16_NEW_MODEL_CALLS=0'
    Write-Output 'ACS_V16_GOLD=NOT_APPROVED'
} catch {
    Write-Output 'ACS_V16_WINDOWS=REJECTED'
    exit 2
}
