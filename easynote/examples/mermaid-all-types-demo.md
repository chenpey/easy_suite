# EasyNote Mermaid 全图型验收

本文件包含 20 个 Mermaid fenced code block（预览上限正好 20），用于验收 Pele 渲染器对常见图型的覆盖。
导入后在预览模式查看；单个图表超过 20 个时，超出部分会显示错误提示。

## 流程图 Flowchart

```mermaid
flowchart LR
  Start([开始]) --> Input[录入需求]
  Input --> Review{评审通过?}
  Review -->|是| Build[进入开发]
  Review -->|否| Input
  Build --> Done([完成])
```

## 时序图 Sequence

```mermaid
sequenceDiagram
  participant 用户
  participant 服务端
  用户->>服务端: 提交笔记
  服务端-->>用户: 返回 revision
  用户->>服务端: 断网继续编辑
```

## 类图 Class

```mermaid
classDiagram
  class Note {
    +String id
    +String title
    +save()
  }
  class Draft {
    +Number revision
  }
  Note <|-- Draft
```

## 状态图 State

```mermaid
stateDiagram-v2
  [*] --> 本地草稿
  本地草稿 --> 待同步: 离线保存
  待同步 --> 已同步: 连接恢复
  已同步 --> [*]
```

## 实体关系图 ER

```mermaid
erDiagram
  USER ||--o{ NOTE : 拥有
  NOTE ||--o{ IMAGE : 引用
  USER {
    string id
    string email
  }
```

## 需求图 Requirement

```mermaid
requirementDiagram
  requirement r1 {
    id: 1
    text: notes must work offline
    risk: low
    verifymethod: test
  }
  element app {
    type: application
  }
  app - satisfies -> r1
```

## 脑图 Mindmap

```mermaid
mindmap
  root((EasyNote))
    编辑
      Markdown
      公式
    预览
      图表
      代码高亮
    离线
      笔记库
      PDF
```

## 时间线 Timeline

```mermaid
timeline
  title 版本节奏
  1.3.9 : 移动窗口优化
  1.3.10 : 备份与待办定位
  1.3.11 : 批量操作区
```

## 用户旅程 Journey

```mermaid
journey
  title 新建一篇笔记
  section 打开
    进入应用: 5: 用户
    新建笔记: 4: 用户
  section 写作
    输入内容: 3: 用户
    查看预览: 5: 用户
```

## 甘特图 Gantt

```mermaid
gantt
  title 迭代计划
  dateFormat YYYY-MM-DD
  section 设计
    需求梳理 :a1, 2026-01-05, 4d
  section 开发
    预览渲染 :after a1, 7d
    离线缓存 :2026-01-16, 5d
```

## 饼图 Pie

```mermaid
pie title 图表类型占比
  "流程图" : 45
  "时序图" : 30
  "脑图" : 25
```

## 四象限 Quadrant

```mermaid
quadrantChart
  title 功能优先级
  x-axis 成本低 --> 成本高
  y-axis 价值低 --> 价值高
  quadrant-1 优先做
  quadrant-2 快速做
  quadrant-3 先不做
  quadrant-4 评估后做
  离线笔记库: [0.7, 0.9]
  PDF 导出: [0.5, 0.6]
```

## Git 图 GitGraph

```mermaid
gitGraph
  commit id: "init"
  branch feature
  commit id: "pele"
  checkout main
  merge feature
  commit id: "release"
```

## 桑基图 Sankey

```mermaid
sankey-beta

Markdown,Preview,60
Markdown,PDF,25
Markdown,Share,15
```

## 坐标图 XYChart

```mermaid
xychart-beta
  title "同步耗时"
  x-axis [1, 2, 3, 4]
  y-axis "毫秒" 0 --> 100
  bar [40, 55, 35, 20]
  line [42, 50, 33, 22]
```

## 块图 Block

```mermaid
block-beta
  columns 3
  编辑器 预览:2
  离线库:3
```

## 架构图 Architecture

```mermaid
architecture-beta
  group client(cloud)[浏览器]
  service app(server)[Worker] in client
  service db(database)[D1] in client
  app:R -- L:db
```

## 雷达图 Radar

```mermaid
radar-beta
  axis speed, size, ease
  curve easynote{80, 70, 90}
  curve mermaid{40, 90, 50}
```

## 泳道图 Swimlane

```mermaid
swimlane-beta
  lane[作者]
    a1[撰写笔记]
    a2[查看预览]
  lane[服务端]
    b1[保存 revision]
  a1 -->|提交| b1
```

## C4 上下文图

```mermaid
C4Context
  title EasyNote 上下文
  Person(user, "笔记作者")
  System(app, "EasyNote")
  System_Ext(browser, "浏览器存储")
  Rel(user, app, "编辑与预览")
  Rel(app, browser, "离线笔记库")
```

## 已知限制（Pele 渲染器）

- `sankey-beta` 的节点名不支持非 ASCII 字符，中文会报 `syntax` 错误，改用英文或拼音。
- `requirementDiagram` 的字段值以中文开头会报 `syntax` 错误（`text: 需要可用` 失败，`text: notes must work offline` 正常）。
- `xychart-beta` 的 `title` 必须加引号（`title "曲线"`）。
- `swimlane-beta` 不是 mermaid 官方语法。泳道写成 `lane[名称]`，节点带 id（`a1[任务]`），连线用 id（`a1 -->|标签| b1`）；`lane A` 和 `write --> save` 都会报解析错。
- 本文件正好 20 个图表，等于预览的单篇渲染上限。
