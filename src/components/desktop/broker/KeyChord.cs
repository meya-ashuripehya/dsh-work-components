namespace DSHDesktopBroker;

/// <summary>
/// 按键名解析。支持单键（enter、a、5、f5、home…）和加号组合（ctrl+a、ctrl+shift+t、alt+f4）。
/// 纯函数，方便单测。
/// </summary>
static class KeyChord
{
    internal const ushort VK_SHIFT = 0x10;
    internal const ushort VK_CONTROL = 0x11;
    internal const ushort VK_MENU = 0x12;
    internal const ushort VK_LWIN = 0x5B;

    internal const string Help = "不认识的按键。可用 enter、tab、backspace、delete、escape、方向键、space、home、end、pageup、pagedown、insert、f1–f12、单个字母或数字，以及 ctrl/alt/shift/win 加号组合（如 ctrl+a、ctrl+shift+t）。";

    internal static bool TryVirtualKey(string name, out ushort vk)
    {
        vk = 0;
        var key = (name ?? "").Trim().ToLowerInvariant();
        if (key.Length == 0) return false;
        vk = key switch
        {
            "enter" or "return" => 0x0D,
            "tab" => 0x09,
            "backspace" => 0x08,
            "delete" or "del" => 0x2E,
            "escape" or "esc" => 0x1B,
            "left" => 0x25,
            "up" => 0x26,
            "right" => 0x27,
            "down" => 0x28,
            "space" => 0x20,
            "home" => 0x24,
            "end" => 0x23,
            "pageup" or "pgup" => 0x21,
            "pagedown" or "pgdn" => 0x22,
            "insert" or "ins" => 0x2D,
            _ => 0,
        };
        if (vk != 0) return true;
        if (key.Length == 1)
        {
            var c = key[0];
            if (c is >= 'a' and <= 'z') { vk = (ushort)char.ToUpperInvariant(c); return true; }
            if (c is >= '0' and <= '9') { vk = c; return true; }
            return false;
        }
        if (key[0] == 'f' && int.TryParse(key.AsSpan(1), out var n) && n is >= 1 and <= 12)
        {
            vk = (ushort)(0x70 + n - 1);
            return true;
        }
        return false;
    }

    static bool TryModifier(string name, out ushort vk)
    {
        vk = name.Trim().ToLowerInvariant() switch
        {
            "ctrl" or "control" => VK_CONTROL,
            "alt" => VK_MENU,
            "shift" => VK_SHIFT,
            "win" or "meta" or "super" or "cmd" => VK_LWIN,
            _ => 0,
        };
        return vk != 0;
    }

    /// <summary>拆 "ctrl+shift+a"。最后一段是主键，其余必须是修饰键。单独一个修饰键也允许（主键即修饰键，无额外修饰）。</summary>
    internal static bool TryParse(string text, out ushort[] modifiers, out ushort vk)
    {
        modifiers = [];
        vk = 0;
        var raw = (text ?? "").Trim();
        if (raw.Length == 0) return false;
        // "ctrl++" 的主键是加号本身，不支持；保留常见写法即可
        var parts = raw.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0) return false;
        var mods = new List<ushort>();
        for (var i = 0; i < parts.Length - 1; i++)
        {
            if (!TryModifier(parts[i], out var m)) return false;
            if (!mods.Contains(m)) mods.Add(m);
        }
        var last = parts[^1];
        if (TryVirtualKey(last, out vk))
        {
            modifiers = mods.ToArray();
            return true;
        }
        if (TryModifier(last, out vk))
        {
            modifiers = mods.ToArray();
            return true;
        }
        return false;
    }
}