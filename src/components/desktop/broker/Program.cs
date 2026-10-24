using DSHDesktopBroker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

DockLayout.BootstrapFromEnv();
var builder = Host.CreateApplicationBuilder(args);
builder.Logging.AddConsole(options =>
{
    options.LogToStandardErrorThreshold = LogLevel.Trace;
});
builder.Services
    .AddMcpServer(options =>
    {
        options.ServerInstructions = "Windows desktop control. Operating loop: look first (screenshot, inspect, or elements), act once, then look again to verify. Prefer ref-based actions over raw coordinates. Before key input make sure focus is in the target field; before scrolling make sure the target point is over the scrollable content. After clicks that open menus, dialogs, or pages, look again before the next step since the UI may still be loading. If an action fails or changes nothing, re-inspect instead of repeating it.";
    })
    .WithStdioServerTransport()
    .WithToolsFromAssembly();
await builder.Build().RunAsync();