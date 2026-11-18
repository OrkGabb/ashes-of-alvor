$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
$endpoint = 'http://127.0.0.1:1234/v1/chat/completions'
$identifier = 'roleplay-local'
$configPath = Join-Path $PSScriptRoot 'config.ini'
$invariant = [Globalization.CultureInfo]::InvariantCulture
$defaults = [ordered]@{
    Pasta = 'historias\Isekai'
    Modelo = ''
    Thinking = '0'
    MaxTokens = '700'
    MaxTokensThinking = '2500'
    Temperatura = '0.8'
    Contexto = '4096'
    Gpu = 'off'
}
# Itens do menu de configuração. Modelo não aparece aqui: é lembrado pelo menu de modelos.
$settingsSpec = @(
    @{Key='Pasta'; Label='Pasta da história'; Kind='text'; Hint='relativa a esta pasta ou caminho completo'}
    @{Key='Thinking'; Label='Thinking'; Kind='toggle'; Hint=''}
    @{Key='MaxTokens'; Label='Tokens por resposta'; Kind='int'; Min=50; Max=8000; Hint='mais = respostas mais longas'}
    @{Key='MaxTokensThinking'; Label='Tokens com thinking'; Kind='int'; Min=200; Max=32000; Hint='pensamento + resposta'}
    @{Key='Temperatura'; Label='Temperatura'; Kind='number'; Min=0; Max=2; Hint='0.6 = contido, 1.0 = solto'}
    @{Key='Contexto'; Label='Contexto (tokens)'; Kind='int'; Min=1024; Max=262144; Hint='mais = mais RAM; vale ao carregar o modelo'}
    @{Key='Gpu'; Label='GPU'; Kind='gpu'; Hint='off, max ou fração de 0 a 1; vale ao carregar o modelo'}
)
$script:cfg = [ordered]@{}
$script:rp = ''
$script:history = @()
$script:modelName = ''

function ConvertTo-SettingValue {
    param([hashtable]$Spec, [string]$Value)
    if ($null -eq $Value) { return $null }
    $v = $Value.Trim()
    switch ($Spec.Kind) {
        'text' { if ($v) { return $v } else { return $null } }
        'toggle' { if ($v -in @('0','1')) { return $v } else { return $null } }
        'int' {
            $n = 0
            if ([int]::TryParse($v, [ref]$n) -and $n -ge $Spec.Min -and $n -le $Spec.Max) { return [string]$n }
            return $null
        }
        'number' {
            $d = 0.0
            if ([double]::TryParse($v.Replace(',', '.'), [Globalization.NumberStyles]::Float, $invariant, [ref]$d) -and
                $d -ge $Spec.Min -and $d -le $Spec.Max) { return $d.ToString($invariant) }
            return $null
        }
        'gpu' {
            $g = $v.ToLowerInvariant()
            if ($g -in @('off','max')) { return $g }
            $d = 0.0
            if ([double]::TryParse($g.Replace(',', '.'), [Globalization.NumberStyles]::Float, $invariant, [ref]$d) -and
                $d -ge 0 -and $d -le 1) { return $d.ToString($invariant) }
            return $null
        }
    }
    return $null
}

function Get-SettingSpec {
    param([string]$Key)
    return @($settingsSpec | Where-Object { $_.Key -eq $Key }) | Select-Object -First 1
}

function Save-Config {
    $lines = @('# Configuração do roleplay. Edite pelo menu do Iniciar-Roleplay.bat ou aqui mesmo.')
    foreach ($key in $script:cfg.Keys) { $lines += "$key=$($script:cfg[$key])" }
    Set-Content -LiteralPath $configPath -Value $lines -Encoding UTF8
}

function Read-Config {
    $script:cfg = [ordered]@{}
    foreach ($key in $defaults.Keys) { $script:cfg[$key] = $defaults[$key] }
    if (Test-Path -LiteralPath $configPath) {
        foreach ($line in (Get-Content -LiteralPath $configPath -Encoding UTF8)) {
            if ($line -notmatch '^\s*(\w+)\s*=(.*)$') { continue }
            $key = $Matches[1]
            if (-not $script:cfg.Contains($key)) { continue }
            $spec = Get-SettingSpec $key
            if ($null -eq $spec) { $value = $Matches[2].Trim() } else { $value = ConvertTo-SettingValue $spec $Matches[2] }
            if ($value) { $script:cfg[$key] = $value } else { Write-Warning "config.ini: valor inválido para $key; usando $($script:cfg[$key])." }
        }
    }
    Save-Config
}

function Test-Thinking { return ($script:cfg.Thinking -eq '1') }

function Format-SettingValue {
    param([hashtable]$Spec)
    if ($Spec.Kind -eq 'toggle') {
        if ($script:cfg[$Spec.Key] -eq '1') { return 'ligado' } else { return 'desligado' }
    }
    return [string]$script:cfg[$Spec.Key]
}

# Mostra o menu até o jogador apertar Enter. Devolve as chaves alteradas.
function Show-ConfigMenu {
    $changed = @()
    while ($true) {
        Write-Host "`nCONFIGURAÇÕES (salvas em config.ini)"
        for ($i = 0; $i -lt $settingsSpec.Count; $i++) {
            Write-Host ("{0} - {1,-21} {2}" -f ($i + 1), $settingsSpec[$i].Label, (Format-SettingValue $settingsSpec[$i]))
        }
        $choice = Read-Host 'Enter = continuar, número = alterar'
        if ([string]::IsNullOrWhiteSpace($choice)) { return $changed }
        $n = 0
        if (-not [int]::TryParse($choice.Trim(), [ref]$n) -or $n -lt 1 -or $n -gt $settingsSpec.Count) {
            Write-Warning 'Opção inválida.'
            continue
        }
        $spec = $settingsSpec[$n - 1]
        if ($spec.Kind -eq 'toggle') {
            if ($script:cfg[$spec.Key] -eq '1') { $value = '0' } else { $value = '1' }
        } else {
            $typed = Read-Host "$($spec.Label) [$($script:cfg[$spec.Key])] ($($spec.Hint); vazio = manter)"
            if ([string]::IsNullOrWhiteSpace($typed)) { continue }
            $value = ConvertTo-SettingValue $spec $typed
            if ($null -eq $value) {
                if ($spec.Kind -in @('int','number')) {
                    Write-Warning "Valor inválido. Use de $($spec.Min) a $($spec.Max)."
                } else {
                    Write-Warning 'Valor inválido.'
                }
                continue
            }
        }
        if ($value -ne $script:cfg[$spec.Key]) {
            $script:cfg[$spec.Key] = $value
            Save-Config
            if ($changed -notcontains $spec.Key) { $changed += $spec.Key }
        }
    }
}

function Resolve-StoryPath {
    param([string]$Folder)
    if ([IO.Path]::IsPathRooted($Folder)) { return $Folder }
    return (Join-Path $PSScriptRoot $Folder)
}

function Set-StoryFolder {
    param([string]$Folder)
    $script:rp = [IO.Path]::GetFullPath($Folder)
    New-Item -ItemType Directory -Force -Path $script:rp | Out-Null
    $initial = @{
        'cenario.txt' = @'
CENÁRIO: Fronteira de Alvor (Mundo de Vaeloria — Fantasia Isekai / Mundo Aberto)
Um continente vasto cortado por ruínas de uma civilização antiga, florestas densas,
estradas de terra batida e fendas por onde vaza mana bruto. Na borda da Mata Cinzenta
fica Cinzas de Alvor: uma cidade murada de fronteira com guilda de aventureiros,
mercado de relíquias, forjas, estalagens barulhentas e caravanas que chegam e saem
todo dia. De tempos em tempos, forasteiros vindos de outro mundo ("Despertos")
aparecem perto dos marcos de pedra antigos sem saber como chegaram ali.

O mundo é aberto: não há roteiro obrigatório. O jogador pode conversar na taverna,
arrumar bico ou quarto, explorar a cidade, aceitar contratos na Guilda, investigar
as ruínas com ou sem companhia, ou simplesmente tentar sobreviver um dia de cada vez.

ELENCO E PERSONAS PRINCIPAIS:
- Luna, 20 anos (Exploradora de Ruínas e Cartógrafa | Parceira / Companion):
  Trabalha por conta própria mapeando zonas instáveis de mana e buscando relíquias
  pequenas que a Guilda evita. Usa um caderno de couro cheio de mapas rabiscados e
  uma lanterna de cristal presa ao cinto. Observadora, curiosa, irônica e direta;
  repara em cada gesto, gíria, roupa estranha ou contradição. Fala de jeito natural
  e espontâneo, como uma jovem brasileira real (sem pompa medieval artificial).
  Tem vontade e rotina próprias: provoca, discorda quando acha uma ideia furada e
  não confia de graça em quem acabou de aparecer. Segredo (só revela se houver muita
  confiança): achou um fragmento de mapa de uma câmara selada sob o Marco da Estrada
  Velha, mas ainda não sabe como ativar o selo.
- Bram, 44 anos (Dono e Taverneiro da Estalagem Lanterna Torta):
  Ex-batedor veterano da fronteira, ombros largos, barba curta grisalha, cicatriz na
  sobrancelha esquerda e um pano sempre no ombro secando canecos de estanho atrás do
  balcão. Pragmático, calmo e observador, com humor seco de quem já viu todo tipo de
  aventureiro e Desperto cruzar a porta sem um cobre no bolso. Fala de forma direta e
  cotidiana. Serve ensopado quente e cerveja da casa, conhece os boatos da região,
  implica de leve com a Luna por espalhar mapas no balcão e sabe negociar (cobra em
  moedas de cobre, mas aceita trabalho no salão, lenha ou pequenos favores).
- Outros habitantes de Cinzas de Alvor:
  - Velho Darian: relojoeiro e avaliador de relíquias que compra achados da Luna e
    sempre tenta pechinchar.
  - Maren: veterana prática e sem paciência que cuida do quadro de contratos e dos
    registros na Praça da Guilda.

LUGARES CONHECIDOS NA REGIÃO:
- Estalagem Lanterna Torta: salão aquecido por lareira de pedra, cheiro de ensopado,
  mesas de madeira riscada, quartos baratos no andar de cima e conversa até tarde.
- Marco da Estrada Velha: monólito de pedra rachada a vinte minutos do portão norte,
  onde o ar cheira a ozônio depois de anomalias de mana.
- Portão Norte e Praça da Guilda: ponto de chegada de caçadores, mercadores e novatos.
- Oficina do Velho Darian: viela perto do mercado, cheia de lentes e artefatos antigos.

CENA INICIAL:
Começo de noite chuvosa na Estalagem Lanterna Torta. Você acabou de entrar no salão
depois de despertar perto do Marco da Estrada Velha. Bram seca um caneco atrás do
balcão e te avalia de canto de olho; na ponta do balcão, Luna revisa seus mapas à
luz da lareira e te mede dos pés à cabeça com curiosidade irônica.
'@
        'jogador.txt' = @'
PERSONAGEM DO JOGADOR (edite antes de jogar ou revele em cena; o que ficar em branco não será inventado)
Nome:
Idade: 20
Origem: veio de outro mundo (despertou há pouco perto de Cinzas de Alvor)
Aparência:
Jeito:
O que traz consigo:
'@
        'memoria.txt' = @'
FATOS CONFIRMADOS:
- Você acabou de despertar nos arredores de Cinzas de Alvor, perto do Marco da Estrada Velha, em um mundo que não reconhece, e entrou na Estalagem Lanterna Torta para sair da chuva.
- Luna (exploradora e cartógrafa) e Bram (dono da taverna) estão no balcão; eles ainda não sabem seu nome nem de onde você veio.

RELAÇÕES (atualizadas a cada turno e com /nota):
- Luna: desconhecidos (humor: curiosa e irônica).
- Bram: atento atrás do balcão, avaliando o recém-chegado.
'@
    }
    foreach ($name in $initial.Keys) {
        $p = Join-Path $script:rp $name
        if (-not (Test-Path -LiteralPath $p)) {
            Set-Content -LiteralPath $p -Value $initial[$name] -Encoding UTF8
        }
    }
    $script:history = @()
    $hp = Join-Path $script:rp '.roleplay-history.json'
    if (Test-Path -LiteralPath $hp) {
        try {
            $stored = @(Get-Content -LiteralPath $hp -Raw -Encoding UTF8 | ConvertFrom-Json)
            $clean = @()
            foreach ($m in $stored) {
                if ($m.role -in @('user','assistant') -and $m.content -is [string]) {
                    $clean += @{role=[string]$m.role; content=[string]$m.content}
                }
            }
            $script:history = @($clean | Select-Object -Last 6)
        } catch { Write-Warning 'Histórico não pôde ser lido. Iniciando sem ele.' }
    }
    Write-Host "Pasta: $script:rp"
}

function Save-History {
    $json = ConvertTo-Json -InputObject @($script:history) -Depth 8
    Set-Content -LiteralPath (Join-Path $script:rp '.roleplay-history.json') -Value $json -Encoding UTF8
}

# Roda o lms sem console de entrada: ele nunca abre menu interativo nem fica
# redesenhando spinner. Devolve a saída limpa (sem ANSI e sem quadros "Loading").
function Invoke-Lms {
    param([string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = @('' | & $lms @Arguments 2>&1 | ForEach-Object { [string]$_ })
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    $lines = @()
    foreach ($line in $raw) {
        $plain = ($line -replace "$([char]27)\[[0-9;?]*[A-Za-z]", '').Trim()
        if ($plain -and $plain -notmatch '^Loading ') { $lines += $plain }
    }
    return [pscustomobject]@{ Code = $code; Text = ($lines -join "`n") }
}

function Get-InstalledModels {
    $result = Invoke-Lms @('ls','--json')
    if ($result.Code -ne 0) { throw "lms ls falhou: $($result.Text)" }
    $parsed = $result.Text | ConvertFrom-Json
    return @($parsed | Where-Object { $_.type -eq 'llm' -and $_.modelKey -like '*abliterated*' } |
        Sort-Object @{Expression={$_.modelKey}})
}

function Get-LoadedModelKey {
    $result = Invoke-Lms @('ps','--json')
    if ($result.Code -ne 0) { return '' }
    $parsed = $result.Text | ConvertFrom-Json
    $match = @($parsed | Where-Object { $_.identifier -eq $identifier }) | Select-Object -First 1
    if ($null -eq $match) { return '' }
    return [string]$match.modelKey
}

function Choose-Model {
    $models = Get-InstalledModels
    if ($models.Count -eq 0) { throw 'Nenhum modelo abliterated instalado no LM Studio.' }
    $defaultIndex = 0
    Write-Host ''
    for ($i = 0; $i -lt $models.Count; $i++) {
        $m = $models[$i]
        if ($m.modelKey -eq $script:cfg.Modelo) { $defaultIndex = $i }
        $size = '{0:N1} GB' -f ($m.sizeBytes / 1GB)
        Write-Host ("{0} - {1}  [{2}, {3}]" -f ($i + 1), $m.displayName, $m.modelKey, $size)
    }
    $choice = Read-Host "Escolha [$($defaultIndex + 1)]"
    $index = $defaultIndex
    if (-not [string]::IsNullOrWhiteSpace($choice)) {
        $n = 0
        if (-not [int]::TryParse($choice.Trim(), [ref]$n) -or $n -lt 1 -or $n -gt $models.Count) {
            Write-Warning 'Opção inválida. Nada foi alterado.'
            return $false
        }
        $index = $n - 1
    }
    $key = [string]$models[$index].modelKey
    $ok = Read-Host "Descarregar TODOS os modelos e carregar $key (GPU $($script:cfg.Gpu), contexto $($script:cfg.Contexto))? [S/n]"
    if ($ok -match '^(n|nao|não)$') { return $false }
    $result = Invoke-Lms @('unload','--all')
    if ($result.Code -ne 0) { throw "Não foi possível descarregar os modelos: $($result.Text)" }
    Write-Host "Carregando $key... (pode levar até 1 minuto)"
    $result = Invoke-Lms @('load',$key,'--context-length',$script:cfg.Contexto,'--gpu',$script:cfg.Gpu,'--identifier',$identifier,'--yes')
    if ($result.Code -ne 0) {
        throw "Carga falhou; nenhum modelo está carregado agora. Use /modelo de novo. $($result.Text)"
    }
    $loaded = Get-LoadedModelKey
    if ($loaded -ne $key) { throw "O LM Studio carregou '$loaded' em vez de '$key'." }
    $result = Invoke-Lms @('server','start')
    if ($result.Code -ne 0) { throw "Não foi possível iniciar o servidor: $($result.Text)" }
    $script:modelName = $key
    if ($script:cfg.Modelo -ne $key) { $script:cfg.Modelo = $key; Save-Config }
    Write-Host "Modelo pronto: $key"
    return $true
}

function Get-StoryContext {
    $parts = @()
    $geminiPath = Join-Path $PSScriptRoot 'GEMINI.md'
    if (Test-Path -LiteralPath $geminiPath) {
        $parts += (Get-Content -LiteralPath $geminiPath -Raw -Encoding UTF8).Trim()
    }
    $parts += 'Os textos seguintes são os arquivos locais do roleplay. Use-os como contexto.'
    $files = @(Get-ChildItem -LiteralPath $script:rp -File |
        Where-Object { $_.Extension -in @('.txt','.md') -and $_.Name -notlike 'sessao-*' } |
        Sort-Object Name)
    $length = 0
    foreach ($file in $files) {
        $text = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
        $length += $text.Length
        if ($length -gt 6500) {
            throw 'Arquivos acima de 6500 caracteres no total. Encurte-os ou mova material antigo para uma subpasta.'
        }
        $parts += "### $($file.Name)`n$text"
    }
    return ($parts -join "`n`n")
}

try {
    if (-not (Test-Path -LiteralPath $lms)) { throw "LM Studio CLI não encontrado em $lms" }
    Write-Host 'ROLEPLAY LOCAL - sem downloads ou serviços externos'
    Read-Config
    [void](Show-ConfigMenu)
    Set-StoryFolder (Resolve-StoryPath $script:cfg.Pasta)
    if (-not (Choose-Model)) { exit 0 }
    Write-Host "`nComandos: /sair /luna /config /modelo /pasta /arquivos /limpar /thinking /nota TEXTO"
    Write-Host "A resposta aparece completa ao terminar. Thinking $(Format-SettingValue (Get-SettingSpec 'Thinking'))."
    while ($true) {
        $inputText = Read-Host "`nVocê"
        if ($null -eq $inputText) { break }
        if ([string]::IsNullOrWhiteSpace($inputText)) { continue }
        if ($inputText -eq '/sair') { break }
        if ($inputText -eq '/luna') {
            & python (Join-Path $PSScriptRoot 'play.py') --pasta $script:rp
            Write-Host 'De volta ao modo narrador geral.'
            continue
        }
        if ($inputText -eq '/config') {
            $changed = @(Show-ConfigMenu)
            if ($changed -contains 'Pasta') {
                try { Set-StoryFolder (Resolve-StoryPath $script:cfg.Pasta) } catch { Write-Warning $_.Exception.Message }
            }
            if ($changed -contains 'Contexto' -or $changed -contains 'Gpu') {
                Write-Host 'Contexto e GPU valem a partir do próximo /modelo.'
            }
            Write-Host 'De volta à história.'
            continue
        }
        if ($inputText -eq '/modelo') {
            try { [void](Choose-Model) } catch { Write-Warning $_.Exception.Message }
            continue
        }
        if ($inputText -eq '/thinking') {
            if (Test-Thinking) { $script:cfg.Thinking = '0' } else { $script:cfg.Thinking = '1' }
            Save-Config
            if (Test-Thinking) {
                Write-Host "Thinking LIGADO: respostas bem mais lentas (limite de $($script:cfg.MaxTokensThinking) tokens)."
            } else {
                Write-Host 'Thinking DESLIGADO.'
            }
            continue
        }
        if ($inputText -eq '/pasta') {
            $folder = Read-Host 'Caminho da pasta (vazio = cancelar)'
            if (-not [string]::IsNullOrWhiteSpace($folder)) {
                try {
                    Set-StoryFolder (Resolve-StoryPath $folder.Trim())
                    $script:cfg.Pasta = $folder.Trim()
                    Save-Config
                } catch { Write-Warning $_.Exception.Message }
            }
            continue
        }
        if ($inputText -eq '/arquivos') {
            Get-ChildItem -LiteralPath $script:rp -File |
                Where-Object { $_.Extension -in @('.txt','.md') -and $_.Name -notlike 'sessao-*' } |
                Select-Object Name,Length | Format-Table | Out-Host
            continue
        }
        if ($inputText -eq '/limpar') {
            if ((Read-Host 'Apagar somente o histórico recente desta história? [s/N]') -match '^(s|sim)$') {
                $script:history = @(); Save-History
                Write-Host 'Histórico limpo. Cenário, memória e logs foram preservados.'
            }
            continue
        }
        if ($inputText.StartsWith('/nota ')) {
            $notaTexto = $inputText.Substring(6).Trim()
            if ($notaTexto) {
                $memFile = Join-Path $script:rp 'memoria.txt'
                $itemNota = "- $($notaTexto.TrimStart('-').Trim())"
                if (Test-Path -LiteralPath $memFile) {
                    $memRaw = Get-Content -LiteralPath $memFile -Raw -Encoding UTF8
                    if ($memRaw -match '(?im)^\s*RELA[ÇC][ÕO]ES\b') {
                        $memRaw = [regex]::Replace($memRaw, '(?im)^(\s*RELA[ÇC][ÕO]ES\b)', "$itemNota`r`n`r`n`$1", 1)
                        Set-Content -LiteralPath $memFile -Value $memRaw.TrimEnd() -Encoding UTF8
                    } else {
                        Add-Content -LiteralPath $memFile -Value $itemNota -Encoding UTF8
                    }
                } else {
                    Set-Content -LiteralPath $memFile -Value "FATOS CONFIRMADOS:`r`n$itemNota" -Encoding UTF8
                }
                Write-Host 'Nota adicionada à memória.'
            }
            continue
        }
        try {
            $systemText = Get-StoryContext
            $recent = @($script:history)
            while ($recent.Count -gt 0 -and (($recent | ForEach-Object {$_.content}) -join '').Length -gt 5000) {
                if ($recent.Count -le 2) { $recent = @() } else { $recent = @($recent | Select-Object -Skip 2) }
            }
            $userMessage = @{role='user'; content=$inputText}
            $messages = @(@{role='system'; content=$systemText}) + $recent + @($userMessage)
            $request = @{
                model=$identifier; messages=$messages
                temperature=[double]::Parse($script:cfg.Temperatura, $invariant)
                max_tokens=[int]$script:cfg.MaxTokens; stream=$false
            }
            if (Test-Thinking) { $request.max_tokens = [int]$script:cfg.MaxTokensThinking } else { $request.reasoning_effort = 'none' }
            $body = $request | ConvertTo-Json -Depth 10
            Write-Host 'Gerando... (aguarde; Ctrl+C interrompe o script)'
            $response = Invoke-RestMethod -Uri $endpoint -Method Post -TimeoutSec 600 `
                -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
            $text = [string]$response.choices[0].message.content
            $text = [regex]::Replace($text, '(?si)<think\b[^>]*>.*?(?:</think\s*>|$)', '')
            $text = [regex]::Replace($text, '(?si)^.*?</think\s*>', '')
            $text = [regex]::Replace($text, '(?si)<(?:estado|status|state)\b[^>]*>.*?(?:</(?:estado|status|state)\s*>|$)', '')
            $text = [regex]::Replace($text, '(?si)\n\s*(?:\*\*|#+)?\s*Estado\s+Atual\s*(?:\*\*)?\s*:.*$', '').Trim()
            if ([string]::IsNullOrWhiteSpace($text)) {
                Write-Warning 'Sem resposta final: o thinking consumiu o limite. Use /thinking ou /config. Nenhum turno foi salvo.'
                continue
            }
            Write-Host "`nNarrador: $text"
            if ($response.choices[0].finish_reason -eq 'length') {
                Write-Warning 'A geração atingiu o limite e pode estar incompleta.'
            }
            $script:history = @($recent) + @($userMessage, @{role='assistant'; content=$text})
            $script:history = @($script:history | Select-Object -Last 6)
            Save-History
            $log = Join-Path $script:rp ('sessao-' + (Get-Date -Format 'yyyy-MM-dd') + '.txt')
            Add-Content -LiteralPath $log -Encoding UTF8 -Value "`n[$(Get-Date -Format 'HH:mm:ss')] $script:modelName`nVocê: $inputText`nNarrador: $text`n"
        } catch {
            Write-Warning $_.Exception.Message
            Write-Host 'Nada foi enviado para serviços externos pelo script. Confira lms ps e o servidor local.'
        }
    }
    Write-Host 'Histórico recente salvo. O modelo e o servidor continuam ativos.'
    if ((Read-Host 'Descarregar o modelo roleplay-local da RAM? [s/N]') -match '^(s|sim)$') {
        [void](Invoke-Lms @('unload',$identifier))
    }
} catch {
    Write-Host ("ERRO: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
