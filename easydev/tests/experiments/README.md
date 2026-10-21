# 实验目录

本目录保存不启动真实模型的离线实验与复验材料。所有外部边界都是本地替身，测试通过 CLI 入口驱动被测脚本。

## 内容

| 路径 | 作用 |
| --- | --- |
| `stubs/codex_stub.py` | 模拟 `codex exec ...`；由 `EASYDEV_STUB_PLAN` JSON 控制事件、reviewer、文件改动、索引暂存、运行时 Skill 编辑、退出码、挂起与子进程。 |
| `stubs/pytest_stub.py` | 模拟 `venv/bin/python -m pytest`；由 `EASYDEV_PYTEST_PLAN` JSON 决定每个 nodeid 的状态，输出 pytest 风格行并写 JUnit XML。 |
| `agent_runner/` | 单宿主行为 runner、B01/B02/B16/public-contract-callers 场景与 CLI 测试。 |
| `swebench/` | SWE-bench Lite 小样本运行器、事件归因与 CLI 测试。 |
| `review-ablation/README.md` | 四臂审查消融协议文档；只定义对照与记录口径，不含可执行检查或实验结果。 |
| `process_control.py` | 行为 runner 与 SWE-bench runner 共用的超时/进程树清理逻辑。 |

## 运行

```bash
python3 -m unittest discover -s tests/experiments/agent_runner -p 'test_*.py' -v
python3 -m unittest discover -s tests/experiments/swebench -p 'test_*.py' -v
```

两组互不依赖，可并行；各自内部用例相互独立，单元测试文件按顺序执行，但单个用例只使用自己的临时目录。

## 替身边界

替身只实现被测脚本实际调用的参数与产物，不 import 被测模块。它们模拟的是外部进程边界（Codex CLI、pytest、时钟），不模拟被测代码的内部结构；断言只检查 `runner.py` / `run.py` / `analyze_events.py` 的 CLI 输出与产物。真实模型行为、真实 pytest 执行和网络隔离都不在离线检查范围内。
