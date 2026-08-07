param(
  [switch]$OpenPanelAfterLink
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$Endpoint = "https://super-zt.com/api/usage-panel"
$AppRoot = $PSScriptRoot
$Node = Join-Path $AppRoot "node\node.exe"
$Cli = Join-Path $AppRoot "bin\usage-panel.js"
$script:LinkedSuccessfully = $false

$form = New-Object System.Windows.Forms.Form
$form.Text = "Link Usage Panel"
$form.Size = New-Object System.Drawing.Size(520, 300)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$icon = Join-Path $AppRoot "usage-panel.ico"
if (Test-Path $icon) { $form.Icon = New-Object System.Drawing.Icon($icon) }

$title = New-Object System.Windows.Forms.Label
$title.Text = "Link this computer to Super ZT"
$title.Location = New-Object System.Drawing.Point(24, 20)
$title.Size = New-Object System.Drawing.Size(455, 28)
$title.Font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($title)

$instructions = New-Object System.Windows.Forms.Label
$instructions.Text = "Create a one-time code at super-zt.com/portal/usage-panel, then paste it below. The code is sent only over HTTPS and is never logged."
$instructions.Location = New-Object System.Drawing.Point(24, 55)
$instructions.Size = New-Object System.Drawing.Size(455, 45)
$form.Controls.Add($instructions)

$codeLabel = New-Object System.Windows.Forms.Label
$codeLabel.Text = "One-time link code"
$codeLabel.Location = New-Object System.Drawing.Point(24, 108)
$codeLabel.Size = New-Object System.Drawing.Size(150, 20)
$form.Controls.Add($codeLabel)

$codeBox = New-Object System.Windows.Forms.TextBox
$codeBox.Location = New-Object System.Drawing.Point(24, 130)
$codeBox.Size = New-Object System.Drawing.Size(455, 24)
$codeBox.UseSystemPasswordChar = $true
$form.Controls.Add($codeBox)

$labelLabel = New-Object System.Windows.Forms.Label
$labelLabel.Text = "Computer name"
$labelLabel.Location = New-Object System.Drawing.Point(24, 162)
$labelLabel.Size = New-Object System.Drawing.Size(150, 20)
$form.Controls.Add($labelLabel)

$labelBox = New-Object System.Windows.Forms.TextBox
$labelBox.Location = New-Object System.Drawing.Point(24, 184)
$labelBox.Size = New-Object System.Drawing.Size(455, 24)
$labelBox.Text = $env:COMPUTERNAME
$form.Controls.Add($labelBox)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(24, 218)
$status.Size = New-Object System.Drawing.Size(320, 28)
$form.Controls.Add($status)

$linkButton = New-Object System.Windows.Forms.Button
$linkButton.Text = "Link computer"
$linkButton.Location = New-Object System.Drawing.Point(360, 216)
$linkButton.Size = New-Object System.Drawing.Size(119, 30)
$form.AcceptButton = $linkButton
$form.Controls.Add($linkButton)

$linkButton.Add_Click({
  $code = $codeBox.Text.Trim()
  $deviceLabel = $labelBox.Text.Trim()
  if (-not $code) {
    [System.Windows.Forms.MessageBox]::Show("Paste the one-time link code first.", "Usage Panel") | Out-Null
    return
  }
  if (-not $deviceLabel) { $deviceLabel = "Windows PC" }
  $deviceLabel = ($deviceLabel -replace '[^A-Za-z0-9 ._-]', '').Trim()
  if (-not $deviceLabel) { $deviceLabel = "Windows PC" }
  if ($deviceLabel.Length -gt 80) { $deviceLabel = $deviceLabel.Substring(0, 80) }
  if (-not (Test-Path $Node)) {
    [System.Windows.Forms.MessageBox]::Show("The bundled runtime is missing. Reinstall Usage Panel.", "Usage Panel") | Out-Null
    return
  }

  $linkButton.Enabled = $false
  $status.Text = "Linking securely..."
  $form.Refresh()
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Node
    $psi.Arguments = '"' + $Cli + '" enroll --endpoint "' + $Endpoint + '" --code-stdin --label "' + $deviceLabel.Replace('"', '') + '"'
    $psi.WorkingDirectory = $AppRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    [void]$process.Start()
    $process.StandardInput.WriteLine($code)
    $process.StandardInput.Close()
    $null = $process.StandardOutput.ReadToEnd()
    $errorText = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $codeBox.Clear()
    $code = $null
    if ($process.ExitCode -ne 0) {
      if (-not $errorText) { $errorText = "The code was rejected or expired." }
      throw $errorText.Trim()
    }
    $script:LinkedSuccessfully = $true
    $status.Text = "Linked. Opening Usage Panel..."
    $linkButton.Text = "Opening Usage Panel..."
    $form.Refresh()
    Start-Sleep -Milliseconds 600
    $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Close()
  } catch {
    $status.Text = "Linking failed."
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Usage Panel") | Out-Null
  } finally {
    $linkButton.Enabled = $true
  }
})

[void]$form.ShowDialog()

if ($script:LinkedSuccessfully) {
  if ($OpenPanelAfterLink) {
    & (Join-Path $AppRoot "open-panel-after-link.ps1")
  }
}
