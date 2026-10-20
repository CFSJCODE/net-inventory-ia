using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using NetInventory.Agent.Windows;
using NetInventory.Contracts;
using NetInventory.Core;

if(args.Contains("--self-check"))
{
    var collector=new WindowsCollector();var id=Guid.NewGuid();var first=collector.Collect(id);await Task.Delay(250);var sample=collector.Collect(id);
    var valid=SampleValidation.Validate(first,DateTimeOffset.UtcNow)is null&&SampleValidation.Validate(sample,DateTimeOffset.UtcNow)is null;
    Console.WriteLine(JsonSerializer.Serialize(new{valid,operatingSystemCollected=sample.OperatingSystem is not null,hardwareCollected=sample.Hardware is not null,adapterCount=sample.Adapters.Length,sessionState=sample.SessionState.ToString(),sessionCount=sample.Sessions.Length,cpuState=sample.Telemetry?.Cpu?.State.ToString(),memoryState=sample.Telemetry?.Memory?.State.ToString(),volumes=sample.Telemetry?.Volumes.Length,disks=sample.Telemetry?.Disks.Length,network=sample.Telemetry?.Network.Length,temperatureState=sample.Telemetry?.TemperatureState.ToString()}));return valid?0:1;
}
var builder=Host.CreateApplicationBuilder(args);
var configIndex=Array.IndexOf(args,"--config-file");
if(configIndex>=0)
{
    if(configIndex+1>=args.Length||!Path.IsPathFullyQualified(args[configIndex+1]))throw new InvalidOperationException("Informe o caminho absoluto do arquivo de configuração.");
    builder.Configuration.AddJsonFile(args[configIndex+1],optional:false,reloadOnChange:false);
}
builder.Services.AddWindowsService(o=>o.ServiceName="NetInventoryDotNetAgent");
var profilePath=builder.Configuration["Agent:HostProfilePath"];
HostProfile? GetProfile()=>profilePath is null?null:new HostProfileService(profilePath).Load();
Uri Endpoint()
{
    var profile=GetProfile();if(profile is not null)return profile.Endpoint;
    if(!Uri.TryCreate(builder.Configuration["Agent:ServerUrl"]??"http://localhost:3000",UriKind.Absolute,out var uri)||uri.UserInfo.Length>0||uri.Query.Length>0||uri.Fragment.Length>0||uri.AbsolutePath!="/")throw new InvalidOperationException("Servidor inválido.");
    var privateHttp=uri.Scheme=="http"&&(uri.IsLoopback&&builder.Configuration.GetValue<bool>("Agent:AllowLoopbackHttp")||System.Net.IPAddress.TryParse(uri.Host,out var ip)&&NetworkPolicy.IsPrivate(ip)&&builder.Configuration.GetValue<bool>("Agent:AllowPrivateLanHttp"));
    if(uri.Scheme!="https"&&!privateHttp)throw new InvalidOperationException("Servidor remoto exige HTTPS; HTTP somente em LAN explicitamente configurada.");return uri;
}
var baseDirectory=builder.Configuration["Agent:DataDirectory"]??Path.Combine(AppContext.BaseDirectory,".data","agent");
using var installation=new AgentState(baseDirectory,allowedUserSid:builder.Configuration["Agent:DataOwnerSid"]);
AgentState Context(Uri uri)=>new AgentState(Path.Combine(baseDirectory,"hosts",HostKey(uri)),installation.AgentId,builder.Configuration["Agent:DataOwnerSid"]);
var endpoint=Endpoint();
using(var context=Context(endpoint))
{
    if(context.Token is null&&GetProfile()?.Mode=="local"&&installation.Token is { } previous)
    {
        using var validation=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){BaseAddress=endpoint,Timeout=TimeSpan.FromSeconds(5)};validation.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",previous);
        try{using var check=await validation.GetAsync($"api/v1/agents/{installation.AgentId}/self");if(check.IsSuccessStatusCode)context.SaveToken(previous);}catch(HttpRequestException){}catch(TaskCanceledException){}
    }
    if(args.Contains("--enrollment-check"))return context.Token is not null?0:2;
    if(args.Contains("--enroll"))
    {
        var invitation=builder.Configuration["Agent:EnrollmentToken"]??throw new InvalidOperationException("Informe um convite individual temporário.");
        using var http=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){BaseAddress=endpoint,Timeout=TimeSpan.FromSeconds(20)};
        using var response=await http.PostAsJsonAsync("api/v1/enrollment",new RedeemInvitationRequest(installation.AgentId,Environment.MachineName,invitation));
        if(!response.IsSuccessStatusCode){Console.WriteLine($"Cadastro recusado ({(int)response.StatusCode}); identidade preservada.");return 2;}
        var enrolled=await response.Content.ReadFromJsonAsync<EnrollResponse>();if(enrolled is null||enrolled.AgentId!=installation.AgentId||enrolled.Token.Length<32)throw new InvalidOperationException("Cadastro inválido.");
        context.SaveToken(enrolled.Token);Console.WriteLine("Agente cadastrado com credencial individual protegida.");return 0;
    }
}
var diagnostics=new DiagnosticState();var runner=new AgentRunner(installation.AgentId,Context,Endpoint,new WindowsCollector(),diagnostics);
if(args.Contains("--once"))return await runner.RunOnce(CancellationToken.None)?0:2;
builder.Services.AddSingleton(runner);builder.Services.AddSingleton(diagnostics);builder.Services.AddHostedService<DiagnosticPipeServer>();builder.Services.AddHostedService<AgentWorker>();
using var host=builder.Build();await host.RunAsync();return 0;
static string HostKey(Uri uri)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(uri.AbsoluteUri))).ToLowerInvariant()[..24];

internal sealed class AgentRunner(Guid installationId,Func<Uri,AgentState> contextFactory,Func<Uri> endpoint,WindowsCollector collector,DiagnosticState diagnostics):IDisposable
{
    private AgentState? state;private Uri? server;private DateTimeOffset? confirmed;
    public void Dispose()=>state?.Dispose();
    public async Task<bool> RunOnce(CancellationToken cancellation)
    {
        Uri target;
        try{target=endpoint();}catch(Exception ex)when(ex is IOException or ArgumentException or InvalidOperationException or JsonException){Console.WriteLine("Configuração do host inválida; nenhuma troca automática para outro banco.");return false;}
        if(server!=target){state?.Dispose();state=contextFactory(target);server=target;confirmed=null;}
        var sample=collector.Collect(installationId);state!.Remember(sample);
        void Status(string communication,string?error=null)=>diagnostics.Set(new(installationId,target.ToString(),communication,state.Pending().Length,state.PendingBytes,sample.CollectedAt,confirmed,error,sample));
        if(SampleValidation.Validate(sample,DateTimeOffset.UtcNow)is not null){Status("Falha na coleta","Amostra inválida");return false;}
        var queued=state.Enqueue(sample);if(!queued)Status("Fila cheia","Limite de amostras ou bytes atingido");
        var token=state.Token;if(token is null){Status("Aguardando cadastro","Informe convite emitido pelo host selecionado");return false;}
        using var http=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){BaseAddress=target,Timeout=TimeSpan.FromSeconds(15)};http.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",token);
        Status("Enviando");
        foreach(var path in state.Pending())
        {
            cancellation.ThrowIfCancellationRequested();InventorySample? pending;
            try{pending=JsonSerializer.Deserialize<InventorySample>(await File.ReadAllTextAsync(path,cancellation),AgentState.Json);}catch(JsonException){Status("Fila exige revisão","Arquivo inválido");return false;}
            if(pending is null||pending.AgentId!=installationId){Status("Fila exige revisão","Identidade divergente");return false;}
            if(pending.CollectedAt<DateTimeOffset.UtcNow.AddDays(-7)){File.Move(path,Path.ChangeExtension(path,".expired"),true);continue;}
            try
            {
                using var response=await http.PostAsJsonAsync("api/v1/agents/samples",pending,AgentState.Json,cancellation);
                if(!response.IsSuccessStatusCode){Status(response.StatusCode==System.Net.HttpStatusCode.Unauthorized?"Autenticação recusada":"Envio recusado",$"HTTP {(int)response.StatusCode}");return false;}
                File.Delete(path);confirmed=DateTimeOffset.UtcNow;
            }
            catch(Exception ex)when(ex is HttpRequestException or TaskCanceledException &&!cancellation.IsCancellationRequested){Status("Sem conexão","Fila preservada para reenvio");return false;}
        }
        Status(queued?"Conectado":"Fila cheia");return queued;
    }
}
internal sealed class AgentWorker(AgentRunner runner,IConfiguration config):BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval=Math.Clamp(config.GetValue("Agent:IntervalSeconds",30),15,3600);var failures=0;
        while(!stoppingToken.IsCancellationRequested)
        {
            var ok=await runner.RunOnce(stoppingToken);failures=ok?0:Math.Min(failures+1,5);
            var delay=ok?interval:Math.Min(300,interval*(1<<failures));
            await Task.Delay(TimeSpan.FromSeconds(delay+Random.Shared.NextDouble()*2),stoppingToken);
        }
    }
}
