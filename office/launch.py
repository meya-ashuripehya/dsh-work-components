"""dsh-work-components 用来拉起 OfficeMCP（stdio）的启动脚本。

OfficeMCP 在启动和执行工具时会直接 print 到标准输出，而 stdio 模式下标准输出就是
MCP 的 JSON-RPC 通道，这些日志会把协议搅乱。这里在导入 OfficeMCP 之前把默认的
print 改到标准错误（被 redirect_stdout 截获的 print 不受影响），然后照常启动。

用法（由插件经 uv 调用，工作目录是 OfficeMCP 仓库）：
    uv run --directory <officemcp 仓库> python launch.py [--folder <绝对路径>]
"""
import builtins
import sys

_REAL_STDOUT = sys.stdout
_print = builtins.print


def _safe_print(*args, **kwargs):
    if kwargs.get("file") is None:
        kwargs["file"] = sys.stderr if sys.stdout is _REAL_STDOUT else sys.stdout
    return _print(*args, **kwargs)


builtins.print = _safe_print


def main() -> None:
    argv = sys.argv[1:]
    folder = None
    if "--folder" in argv:
        i = argv.index("--folder")
        if i + 1 < len(argv):
            folder = argv[i + 1]
    # OfficeMCP 只从第二个参数起解析 --folder，第一个参数是传输方式。
    sys.argv = ["officemcp", "stdio"] + (["--folder", folder] if folder else [])
    from officemcp import main as office_main

    office_main()


if __name__ == "__main__":
    main()
