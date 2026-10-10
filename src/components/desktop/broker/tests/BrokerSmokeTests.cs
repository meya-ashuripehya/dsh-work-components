using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace DSHDesktopBroker.Tests;

public class BrokerSmokeTests
{
    [Fact]
    public async Task StatusAndWindowList()
    {
        var exe = BrokerExe();
        var transport = new StdioClientTransport(new StdioClientTransportOptions
        {
            Name = "desktop-smoke",
            Command = exe,
            Arguments = [],
        });
        await using var client = await McpClient.CreateAsync(transport);
        var names = (await client.ListToolsAsync()).Select(tool => tool.Name).OrderBy(name => name).ToArray();
        Assert.Equal(
            ["click", "click_screen", "inspect", "invoke", "key", "list_windows", "screenshot", "scroll", "scroll_screen", "status", "type"],
            names);
        var status = await client.CallToolAsync("status", new Dictionary<string, object?>());
        var statusText = TextOf(status);
        var body = JsonDocument.Parse(statusText).RootElement;
        Assert.False(body.GetProperty("uiAccess").GetBoolean());
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("integrity").GetString()));
        var windows = await client.CallToolAsync("list_windows", new Dictionary<string, object?>());
        var listed = JsonDocument.Parse(TextOf(windows)).RootElement;
        Assert.True(listed.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task InspectDump()
    {
        var exe = BrokerExe();
        var transport = new StdioClientTransport(new StdioClientTransportOptions
        {
            Name = "desktop-inspect",
            Command = exe,
            Arguments = [],
        });
        await using var client = await McpClient.CreateAsync(transport);
        var listed = JsonDocument.Parse(TextOf(await client.CallToolAsync("list_windows", new Dictionary<string, object?>()))).RootElement;
        var best = 0;
        var chromium = 0;
        string? error = null;
        var n = 0;
        foreach (var window in listed.GetProperty("windows").EnumerateArray())
        {
            if (n++ >= 12) break;
            var text = TextOf(await client.CallToolAsync("inspect", new Dictionary<string, object?>
            {
                ["hwnd"] = window.GetProperty("hwnd").GetString(),
            }));
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            var count = root.TryGetProperty("elements", out var elements) ? elements.GetArrayLength() : 0;
            if (count > best) best = count;
            if (root.TryGetProperty("chromiumHostFound", out var flag) && flag.GetBoolean())
                chromium = Math.Max(chromium, count);
            if (root.TryGetProperty("uiaError", out var err) && err.ValueKind == JsonValueKind.String)
                error ??= err.GetString();
        }
        Assert.True(best > 0, error ?? "inspect 没有读到任何控件");
        Assert.True(chromium > 1, $"Chromium 窗口只读到 {chromium} 个元素");
    }

    static string BrokerExe()
    {
        var exe = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "dist", "DSHDesktopBroker.exe"));
        Assert.True(File.Exists(exe), exe);
        return exe;
    }

    static string TextOf(CallToolResult result) =>
        result.Content.OfType<TextContentBlock>().Single().Text ?? "";
}
