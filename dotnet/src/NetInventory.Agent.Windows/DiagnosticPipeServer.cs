using System.IO.Pipes;
using System.Text.Json;
using NetInventory.Contracts;
using System.Security.AccessControl;
using System.Security.Principal;
namespace NetInventory.Agent.Windows;

internal sealed class DiagnosticState
{
    private readonly object gate=new();private AgentDiagnostics? current;
    public AgentDiagnostics? Read(){lock(gate)return current;}
    public void Set(AgentDiagnostics value){lock(gate)current=value;}
}
internal sealed class DiagnosticPipeServer(DiagnosticState state,IConfiguration configuration):BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while(!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);
                foreach(var sid in new[]{WindowsIdentity.GetCurrent().User!,new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null)})security.AddAccessRule(new PipeAccessRule(sid,PipeAccessRights.FullControl,AccessControlType.Allow));
                if(configuration["Agent:DiagnosticUserSid"]is{} userSid)security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(userSid),PipeAccessRights.ReadWrite,AccessControlType.Allow));
                await using var pipe=NamedPipeServerStreamAcl.Create("NetInventory.Agent.Local",PipeDirection.Out,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,0,0,security);
                await pipe.WaitForConnectionAsync(stoppingToken);
                using var writer=new StreamWriter(pipe,leaveOpen:true){AutoFlush=true};
                await writer.WriteLineAsync(JsonSerializer.Serialize(state.Read(),AgentState.Json).AsMemory(),stoppingToken);
            }
            catch(OperationCanceledException)when(stoppingToken.IsCancellationRequested){break;}
            catch(IOException){await Task.Delay(500,stoppingToken);}
        }
    }
}
