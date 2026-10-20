using System.Diagnostics;
using NetInventory.Server.Host;

if (!OperatingSystem.IsWindows()) { Console.WriteLine("Validação exclusiva Windows."); return; }
var node = @"C:\Program Files\NetInventory\node\node.exe";
if (!File.Exists(node)) throw new InvalidOperationException("Node instalado necessário para o processo sintético.");
var checks = 0;
void Check(bool valid, string label) { if (!valid) throw new InvalidOperationException("Falha: " + label); checks++; Console.WriteLine("OK: " + label); }
var info = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
info.ArgumentList.Add("-e");
info.ArgumentList.Add("process.stdin.once('data',()=>{const p=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(p.pid);});setInterval(()=>{},1000);");
using var child = Process.Start(info)!;
using var job = WindowsOwnedChildJob.Attach(child);
Check(!child.HasExited, "filho próprio inicia protegido sem encerrar outros processos");
await child.StandardInput.WriteLineAsync("spawn"); await child.StandardInput.FlushAsync();
var line = await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
using var grandchild = Process.GetProcessById(int.Parse(line!));
Check(!grandchild.HasExited, "descendente herda proteção do filho");
job.Dispose();
Check(child.WaitForExit(10000), "fechamento do job encerra filho próprio");
Check(grandchild.WaitForExit(10000), "fechamento do job encerra descendente próprio");
using var self = Process.GetCurrentProcess();
try { using var denied = WindowsOwnedChildJob.Attach(self); Check(false, "processo chamador não pode ser capturado"); }
catch (InvalidOperationException) { Check(true, "processo chamador não pode ser capturado"); }
Check(!self.HasExited, "rejeição preserva o processo chamador");
Console.WriteLine($"Validação da duração dos filhos: {checks} verificações concluídas. Somente processos sintéticos próprios; nenhum serviço instalado alterado.");
