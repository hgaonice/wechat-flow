/**
 * 九年级上册推文计划生成器（一次性工具，不进引擎运行时）。
 *
 * 依据 docs/img/ 大纲照片整理的 37 讲 / 171 板块，生成：
 *   - 每板块 1 篇 + 每讲 1 篇汇总 = 208 天（2026-10-16 ~ 2027-05-13）
 *   - 两账号各一套：second（巧思初数，教学视角）、gaoh（gaoh的技术分享，技术视角）
 * 输出：out/plans/<alias>/<week>.json（与引擎物化格式一致，供控制台 API 写入）
 *
 * 用法：
 *   bun tools/gen-grade9-plans.ts          # 生成 + 校验
 *   bun tools/gen-grade9-plans.ts --check  # 仅校验已有输出
 */
import fs from "node:fs";
import path from "node:path";

const START = "2026-10-16";
const OUT_DIR = path.join(import.meta.dir, "..", "out", "plans");

interface Board {
  name: string;
  /** 该板块知识点的中考定位短语（写进 topic） */
  exam: string;
  /** 历年中考真题要点（写进 outline，agent 写作时展开拆解） */
  zhenti: string[];
  /** 易错/难点提示 */
  pitfall: string;
  /** 适合 manim 动画时给出场景建议 */
  manim?: string;
  difficulty: "易" | "中" | "难";
}

interface Lecture {
  no: number;
  chapter: string;
  title: string;
  boards: Board[];
}

// ── 大纲数据（37 讲，与 prd.md 附录 A 一致） ──────────────────────────────

const LECTURES: Lecture[] = [
  {
    no: 1, chapter: "第二十五章 一元二次方程", title: "一元二次方程及其解法",
    boards: [
      { name: "追根溯源——一元二次方程的根", exam: "根的概念与代入验证是中考选择填空常客", zhenti: ["2023 江苏南京中考：已知 x=1 是方程 x²+mx-3=0 的根求 m", "2022 四川成都中考：根的定义结合整体代入求代数式的值"], pitfall: "「代入根求参」后忘记代回检验方程是否仍为二次", difficulty: "易", manim: "方程 ax²+bx+c=0 的根与抛物线 y=ax²+bx+c 和 x 轴交点的对应动画" },
      { name: "解一元二次方程", exam: "直接开平方、配方法、公式法、因式分解法四法择优是计算题必考", zhenti: ["2023 北京中考：解方程 x²-4x-5=0（因式分解法）", "2024 湖北武汉中考：用配方法解 2x²-4x-6=0", "2022 广东中考：公式法解含小数系数的方程"], pitfall: "因式分解法两边直接约去含未知数的因式导致丢根", difficulty: "易", manim: "配方法几何演示：x²+bx 补成正方形的面积拼图动画" },
      { name: "可化为一元二次方程的方程", exam: "分式方程、根式方程、高次方程化归是中考拉分点", zhenti: ["2023 上海中考：解分式方程并验根", "2022 浙江杭州中考：换元法解 (x²+x)²-4(x²+x)-12=0"], pitfall: "分式方程忘记验根、根式方程平方后产生增根不检验", difficulty: "中" },
      { name: "配方法的应用(一)求值及比大小", exam: "配方求代数式值、比较大小是中考填选压轴常见手法", zhenti: ["2023 山东中考：比较 M=3x²-2x+1 与 N=2x²+x 的大小（作差配方）", "2021 江苏苏州中考：已知 a+b=4, ab=1 配方求 a²+b²"], pitfall: "作差后配方不彻底、符号判断丢步", difficulty: "中" },
      { name: "配方法的应用(二)求最值", exam: "配方求二次式最值是函数最值问题的代数根基", zhenti: ["2024 安徽中考：求 2x²-8x+9 的最小值", "2022 湖南长沙中考：实际背景中配方求面积最大值"], pitfall: "忽略自变量取值范围，顶点不在范围内时最值在端点", difficulty: "中", manim: "y=a(x-h)²+k 顶点随配方过程移动的动画" },
    ],
  },
  {
    no: 2, chapter: "第二十五章 一元二次方程", title: "一元二次方程根的判别式",
    boards: [
      { name: "根的判别式", exam: "Δ=b²-4ac 判断根的情况每年必考", zhenti: ["2024 河南中考：k 为何值时方程有两个不相等实数根", "2023 重庆中考：判别式与方程整数根结合"], pitfall: "「有两个实数根」漏掉 Δ=0 的情形；二次项系数含参时忘讨论 a≠0", difficulty: "易", manim: "Δ 变化时抛物线与 x 轴交点数从 2→1→0 的连续动画" },
      { name: "根的判别式的综合运用", exam: "判别式与参数范围、几何存在性结合是压轴常客", zhenti: ["2023 四川绵阳中考：判别式结合三角形边长条件求参数", "2022 江西中考：一元二次方程与一次函数图象交点个数问题"], pitfall: "多条件交集时漏掉隐含约束（如系数非零、边长为正）", difficulty: "中" },
    ],
  },
  {
    no: 3, chapter: "第二十五章 一元二次方程", title: "根系关系及其应用",
    boards: [
      { name: "求解两根对称式", exam: "韦达定理求 x₁²+x₂²、1/x₁+1/x₂ 等对称式是必考题", zhenti: ["2024 湖北黄冈中考：已知两根求对称式的值", "2023 云南中考：x₁²+x₂²=(x₁+x₂)²-2x₁x₂ 的直接运用"], pitfall: "公式变形记错（平方和与和平方混淆）", difficulty: "易" },
      { name: "求解两根非对称式", exam: "非对称式需先对称化或用方程定义消元", zhenti: ["2022 四川中考：求 x₁²+x₂ 的值（先用 x₁²=... 降次）", "2023 福建中考：非对称式结合方程根的定义"], pitfall: "直接套对称式公式导致无法求解", difficulty: "中" },
      { name: "根系关联判别式", exam: "根系关系+判别式双约束求参数是经典考法", zhenti: ["2024 湖南中考：已知两根平方和求 k 并验证 Δ≥0", "2023 贵州中考：根系关系求出的参数必须用判别式筛掉增解"], pitfall: "只求出参数不验证 Δ≥0，多解不筛", difficulty: "中" },
      { name: "分类解析根分布", exam: "根的正负、根与某数的大小关系分类讨论是难点", zhenti: ["2022 湖北武汉中考：两根异号求参数范围", "2023 江苏无锡中考：两根均大于 1 的条件转化"], pitfall: "「两根同号」条件列不全（积>0 还需 Δ≥0）", difficulty: "难" },
      { name: "根与根系构方程", exam: "已知两根反求方程、构造新方程是逆向考法", zhenti: ["2023 辽宁中考：以 2x₁+1、2x₂+1 为根构造新方程", "2021 山东青岛中考：根系关系求作一元二次方程"], pitfall: "构造方程时和与积算错，忘写二次项系数", difficulty: "中" },
    ],
  },
  {
    no: 4, chapter: "第二十五章 一元二次方程", title: "实际问题与一元二次方程",
    boards: [
      { name: "面积、几何图形问题", exam: "矩形围边、甬道、镶边面积建模每年各地必考", zhenti: ["2024 河北中考：矩形花园中间修路求路宽", "2023 山西中考：靠墙围矩形菜园列方程"], pitfall: "设元不清、面积表达式漏减重叠部分", difficulty: "中", manim: "矩形甬道平移拼合求面积的动态演示" },
      { name: "传染、变化率问题", exam: "平均增长/降低率 a(1±x)²=b 模型是热点", zhenti: ["2024 江西中考：某商品两次降价求平均降价率", "2023 吉林中考：病毒传染两轮后总人数模型"], pitfall: "变化率问题基数搞错（第二轮基数是第一轮结果）", difficulty: "中" },
      { name: "数字、循环问题", exam: "两位/三位数数字问题与单双循环比赛场次", zhenti: ["2022 甘肃中考：两位数数字交换列方程", "2023 广西中考：n 支队单循环 x(x-1)/2 场次模型"], pitfall: "单循环除以 2、双循环不除 2 混淆", difficulty: "中" },
      { name: "销售问题", exam: "「每涨 x 元少卖 y 件」利润方程是中考应用题顶流", zhenti: ["2024 山东中考：涨价减销求售价使日利润达标", "2023 湖北宜昌中考：销售利润方程+取舍增根"], pitfall: "两个解都要按实际意义（销量非负、涨价幅度合理）取舍", difficulty: "中" },
    ],
  },
  {
    no: 5, chapter: "第二十六章 二次函数", title: "二次函数的图象与性质",
    boards: [
      { name: "二次函数的对称性", exam: "对称轴、对称点坐标是填空高频", zhenti: ["2024 天津中考：抛物线上对称点的纵坐标关系", "2023 陕西中考：已知两点横坐标求对称轴"], pitfall: "对称轴公式 x=-b/2a 符号记错", difficulty: "易", manim: "抛物线沿对称轴折叠重合的动画" },
      { name: "二次函数的增减性", exam: "开口方向+对称轴分区判断增减是必考", zhenti: ["2023 浙江温州中考：比较三个函数值大小", "2024 辽宁沈阳中考：给定区间求增减性"], pitfall: "比较函数值时不统一到对称轴同侧", difficulty: "易", manim: "点沿抛物线滑动时纵坐标升降的动画" },
      { name: "二次函数与图形变换", exam: "平移规律「左加右减、上加下减」年年考", zhenti: ["2024 四川成都中考：抛物线平移后求解析式", "2023 湖南株洲中考：平移+对称复合变换"], pitfall: "左右平移对 x 操作方向混淆", difficulty: "中", manim: "y=x² 平移到 y=(x-2)²+3 的连续位移动画" },
    ],
  },
  {
    no: 6, chapter: "第二十六章 二次函数", title: "二次函数与方程、不等式",
    boards: [
      { name: "二次函数与一元二次方程", exam: "图象交点↔方程根的转化是函数观点核心", zhenti: ["2024 江苏南京中考：由图象读方程 ax²+bx+c=0 的解", "2023 安徽中考：抛物线与 x 轴交点个数判断"], pitfall: "方程 ax²+bx+c=m 的解对应 y=m 水平线而非 x 轴", difficulty: "中", manim: "水平线 y=m 上下移动与抛物线交点个数变化" },
      { name: "二次函数与不等式", exam: "图象法解不等式 ax²+bx+c>0 是数形结合必考", zhenti: ["2023 湖北武汉中考：读图写不等式解集", "2024 河南中考：不等式解集与参数"], pitfall: "大于取两边、小于取中间的口诀用反（开口方向）", difficulty: "中" },
      { name: "二次函数与公共点", exam: "直线与抛物线公共点个数=联立方程判别式", zhenti: ["2024 广东中考：直线与抛物线恰有一个公共点求 k", "2022 福建中考：线段与抛物线有交点的参数范围"], pitfall: "「线段」与「直线」混淆——线段还要检验交点在线段范围内", difficulty: "难" },
      { name: "二次函数与根系关系", exam: "交点横坐标满足韦达定理是代数化关键", zhenti: ["2023 四川南充中考：两交点横坐标关系求参数", "2024 贵州中考：韦达定理处理交点距离"], pitfall: "联立后忘验 Δ>0", difficulty: "中" },
      { name: "二次函数与根的分布", exam: "用函数图象约束根的范围是压轴手法", zhenti: ["2022 湖北中考：一根在 0~1、一根在 2~3 求参数（端点函数值符号法）", "2023 山西中考：根的分布三类条件"], pitfall: "端点符号条件列不全（开口方向、对称轴位置都要）", difficulty: "难" },
      { name: "二次函数与参变分离法", exam: "参变分离转化为函数值域是新趋势考法", zhenti: ["2024 浙江中考：分离参数 a=x²+2x 求有解范围", "2023 江苏南通中考：参变分离+图象交点"], pitfall: "分离后忘考虑分母为零或除式正负改变不等号方向", difficulty: "难" },
    ],
  },
  {
    no: 7, chapter: "第二十六章 二次函数", title: "二次函数与区间最值",
    boards: [
      { name: "定轴定区间", exam: "对称轴与区间的三种位置关系求最值是基础模型", zhenti: ["2024 云南中考：y=x²-2x 在 [0,3] 上的最值", "2023 甘肃中考：定区间最值分类"], pitfall: "直接代端点漏掉顶点在区间内的情况", difficulty: "中", manim: "区间左右滑动、最值点在端点与顶点间切换的动画" },
      { name: "定轴动区间", exam: "区间含参数 t，按 t 分类讨论最值", zhenti: ["2023 湖北武汉中考：区间 [t,t+1] 上最大值表达式", "2024 湖南中考：动区间最值分段函数"], pitfall: "分类标准找不准（轴与区间端点/中点的位置）", difficulty: "难" },
      { name: "动轴定区间", exam: "对称轴含参数，按轴的位置讨论", zhenti: ["2024 山东青岛中考：y=x²-2ax 在 [0,2] 最小值", "2022 江苏中考：动轴三类讨论"], pitfall: "最大值与最小值分类标准不同，混用", difficulty: "难" },
    ],
  },
  {
    no: 8, chapter: "第二十六章 二次函数", title: "二次函数与多结论",
    boards: [
      { name: "二次函数与多结论(一)图象信息", exam: "由图象判断 abc、b²-4ac、a+b+c 符号是填选压轴标配", zhenti: ["2024 湖北襄阳中考：图象信息判断 5 个结论个数", "2023 山东烟台中考：abc 符号+2a+b 范围"], pitfall: "2a+b 这类组合式不会用对称轴范围转化", difficulty: "中", manim: "改变 a/b/c 时图象形态联动变化的动画" },
      { name: "二次函数与多结论(二)表格信息", exam: "由表格数据反推对称轴与最值", zhenti: ["2023 北京中考：表格中对称数据求解析式", "2024 河北中考：表格+多结论判断"], pitfall: "没发现表格中的对称数据对", difficulty: "中" },
      { name: "二次函数与多结论(三)文字信息", exam: "文字描述条件逐条翻译为代数约束", zhenti: ["2024 四川中考：文字条件判断结论正误", "2022 湖北宜昌中考：多条件综合"], pitfall: "条件漏用导致结论误判", difficulty: "难" },
    ],
  },
  {
    no: 9, chapter: "第二十六章 二次函数", title: "实际问题与二次函数",
    boards: [
      { name: "面积问题(一)面积最值计算", exam: "围栏/矩形面积最值是应用题经典", zhenti: ["2024 吉林中考：靠墙围栏最大面积", "2023 黑龙江中考：矩形内接图形面积"], pitfall: "自变量范围不写，顶点超出实际意义", difficulty: "中", manim: "矩形边长变化时面积曲线同步上升的联动动画" },
      { name: "面积问题(二)面积最值求参", exam: "已知最值反求参数是逆向考法", zhenti: ["2023 广西南宁中考：最大面积已知求边长参数", "2022 海南中考：面积最值条件求围栏长度"], pitfall: "顶点纵坐标公式代错", difficulty: "中" },
      { name: "面积问题(三)面积加权最值", exam: "多区域不同单价求总造价最值", zhenti: ["2024 贵州中考：种植不同作物加权面积最值", "2023 云南曲靖中考：造价加权模型"], pitfall: "加权系数位置放错", difficulty: "中" },
      { name: "利润问题(一)区间内顶点最值", exam: "利润二次函数顶点在区间内取最值", zhenti: ["2024 湖北武汉中考：售价利润模型顶点取最值", "2023 湖南长沙中考：日利润最大化"], pitfall: "顶点横坐标不是整数时需比较相邻整数", difficulty: "中" },
      { name: "利润问题(二)区间内端点最值", exam: "顶点在区间外时最值在端点", zhenti: ["2023 辽宁中考：限价区间内端点取最大利润", "2024 陕西西安中考：区间端点最值"], pitfall: "不看轴与区间位置直接套顶点", difficulty: "中" },
      { name: "利润问题(三)区间内取整最值", exam: "售价/件数为整数时最值取整比较", zhenti: ["2024 山西中考：整数售价下最大利润", "2022 江西中考：取整两邻值比较"], pitfall: "只取 floor 忘比较 ceil", difficulty: "中" },
      { name: "利润问题(四)区间求参", exam: "由最值条件反求售价区间参数", zhenti: ["2023 浙江金华中考：利润不低于某值求售价范围", "2024 安徽安庆中考：区间求参"], pitfall: "不等式方向与图象开口结合出错", difficulty: "难" },
      { name: "利润问题(五)关联变量利润和", exam: "两种商品关联销量求总利润最值", zhenti: ["2024 重庆中考：A、B 商品销量关联总利润", "2023 四川泸州中考：关联变量消元"], pitfall: "关联条件消元代错", difficulty: "难" },
      { name: "利润问题(六)分段函数取最值", exam: "不同销量区间不同单价的分段利润", zhenti: ["2024 河南郑州中考：分段定价利润最值", "2023 湖北黄冈中考：分段函数两段比较"], pitfall: "分段点处连续性不检验、两段最值不比较", difficulty: "难" },
      { name: "抛物线形问题(一)实物长度计算", exam: "拱桥、隧道抛物线建模求宽度/长度", zhenti: ["2024 山东济南中考：拱桥水面宽度", "2023 福建福州中考：隧道通行宽度"], pitfall: "建系不同导致解析式符号错", difficulty: "中", manim: "拱桥抛物线建模：水位上涨时通行宽度变窄的动画" },
      { name: "抛物线形问题(二)路径高度分析", exam: "投篮、喷泉轨迹求最高点/某处高度", zhenti: ["2024 河北中考：篮球轨迹过篮筐高度判断", "2023 吉林长春中考：喷泉高度"], pitfall: "「能否通过」要代横坐标比较高度而非只求顶点", difficulty: "中", manim: "篮球抛物线轨迹与篮筐高度对比动画" },
      { name: "抛物线形问题(三)路径落点分析", exam: "抛体落点距离=求零点", zhenti: ["2023 广东深圳中考：铅球落点距离", "2024 广西北部湾中考：跳水落点"], pitfall: "零点取负根不舍", difficulty: "中" },
      { name: "抛物线形问题(四)直线运动建模", exam: "相遇/追及中距离关于时间的二次建模", zhenti: ["2024 湖北鄂州中考：两车距离最小值", "2022 湖南永州中考：运动建模"], pitfall: "距离公式平方后忘开方讨论", difficulty: "难" },
    ],
  },
  {
    no: 10, chapter: "第二十六章 二次函数", title: "二次函数与线段",
    boards: [
      { name: "横竖线段", exam: "竖线段长=纵坐标差是铅垂法基础", zhenti: ["2024 四川眉山中考：抛物线上竖线段最大值", "2023 湖北随州中考：横线段长度"], pitfall: "上下位置不定时要加绝对值分类", difficulty: "中", manim: "竖直动线段长度随 x 变化的动画" },
      { name: "斜线段", exam: "斜线段化竖线段（k 倍关系）是核心技巧", zhenti: ["2024 江苏盐城中考：斜线段最值化竖直处理", "2023 浙江绍兴中考：定直线上斜线段"], pitfall: "斜化竖的比例系数 k 由直线斜率决定，不会推", difficulty: "难" },
      { name: "等线段", exam: "两线段相等列方程（注意多解）", zhenti: ["2023 山东聊城中考：两线段相等求点坐标", "2024 辽宁大连中考：等线段分类"], pitfall: "绝对值方程只解一种情形", difficulty: "中" },
      { name: "倍线段", exam: "倍数关系转化纵坐标倍数", zhenti: ["2024 湖北恩施中考：2 倍线段求点", "2022 广西玉林中考：倍线段存在性"], pitfall: "倍数关系方向写反", difficulty: "中" },
      { name: "平行", exam: "平行线斜率相等列方程", zhenti: ["2023 湖南岳阳中考：与定直线平行求点", "2024 贵州遵义中考：平行四边形中平行条件"], pitfall: "斜率公式两点代错顺序", difficulty: "中" },
      { name: "垂直", exam: "垂直用斜率积为-1 或构造三垂直相似", zhenti: ["2024 湖北十堰中考：直角存在性三垂直模型", "2023 四川广安中考：垂直条件求点"], pitfall: "竖直/水平直线斜率不存在的情形漏讨论", difficulty: "难" },
    ],
  },
  {
    no: 11, chapter: "第二十六章 二次函数", title: "二次函数与面积",
    boards: [
      { name: "割补法", exam: "不规则图形割补成可算图形是通法", zhenti: ["2023 湖北咸宁中考：四边形面积割补", "2024 甘肃天水中考：割补求面积最值"], pitfall: "割补后重叠部分重复计算", difficulty: "中", manim: "四边形分割成两个三角形的动态演示" },
      { name: "铅垂法", exam: "S=½×铅垂高×水平宽是抛物线面积第一技法", zhenti: ["2024 湖北孝感中考：铅垂法求三角形面积最值", "2023 湖南郴州中考：铅垂高模型"], pitfall: "水平宽取错（应为两交点横坐标差）", difficulty: "中", manim: "铅垂线切分三角形面积的动画" },
      { name: "平行转化法", exam: "同底等高平行转化化斜为正", zhenti: ["2024 山东枣庄中考：平行线转化等面积", "2022 湖北鄂州中考：等积变形"], pitfall: "找不到等高的平行线", difficulty: "难" },
      { name: "面积转化技巧", exam: "等底等高、燕尾、一半模型等转化大全", zhenti: ["2024 四川巴中中考：面积转化综合", "2023 重庆渝北中考：一半模型"], pitfall: "转化链长时中间环节丢失", difficulty: "难" },
    ],
  },
  {
    no: 12, chapter: "第二十六章 二次函数", title: "二次函数与角度",
    boards: [
      { name: "等角(一)构等腰", exam: "等角对等边构等腰三角形", zhenti: ["2024 湖北荆门中考：等角构等腰求点", "2023 江苏宿迁中考：角相等转化为等腰"], pitfall: "等腰三情形不分类", difficulty: "难" },
      { name: "等角(二)构全等", exam: "等角+等边构全等三角形", zhenti: ["2023 湖北荆州中考：构全等转移等角", "2024 湖南怀化中考：全等转化"], pitfall: "全等对应关系找错", difficulty: "难" },
      { name: "倍角", exam: "倍角构对称或等腰转化", zhenti: ["2024 四川内江中考：二倍角转化等角", "2022 湖北天门中考：倍角模型"], pitfall: "倍角作对称后对应点算错", difficulty: "难" },
      { name: "45°角", exam: "45°构等腰直角或正方形", zhenti: ["2024 黑龙江哈尔滨中考：45°角存在性", "2023 湖北仙桃中考：45°构等腰直角"], pitfall: "45°可在两侧，漏解", difficulty: "难" },
      { name: "角的和差", exam: "和差角用三角或构造转化", zhenti: ["2023 四川遂宁中考：两角和为定值", "2024 广西桂林中考：角差问题"], pitfall: "和差角位置情形多，分类不全", difficulty: "难" },
    ],
  },
  {
    no: 13, chapter: "第二十六章 二次函数", title: "二次函数与特殊图形",
    boards: [
      { name: "二次函数与等腰三角形", exam: "等腰存在性两圆一线模型", zhenti: ["2024 湖北黄冈中考：等腰三角形存在性求点", "2023 云南昆明中考：两圆一线"], pitfall: "三种等腰情形（AB=AC、BA=BC、CA=CB）漏分类", difficulty: "难", manim: "两圆一线法找等腰三角形第三顶点的动画" },
      { name: "二次函数与平行四边形", exam: "对角线互相平分中点公式法", zhenti: ["2024 四川达州中考：平行四边形存在性", "2023 湖北襄阳中考：中点坐标法"], pitfall: "对角线 pairing 三种情形漏", difficulty: "难" },
      { name: "二次函数与菱形、正方形", exam: "菱形邻边相等、正方形边等且垂直", zhenti: ["2024 湖南娄底中考：菱形存在性", "2023 湖北宜昌中考：正方形存在性"], pitfall: "先平行四边形再加条件，顺序不能反", difficulty: "难" },
    ],
  },
  {
    no: 14, chapter: "第二十六章 二次函数", title: "抛物线与平移、对称",
    boards: [
      { name: "平移", exam: "抛物线平移解析式与几何平移联动", zhenti: ["2024 天津中考：抛物线平移过定点", "2023 北京中考：平移后与直线关系"], pitfall: "平移向量方向与解析式变化对应错", difficulty: "中", manim: "抛物线整体平移、顶点轨迹动画" },
      { name: "对称", exam: "关于轴/点对称求新抛物线", zhenti: ["2024 辽宁中考：关于 y 轴对称的抛物线", "2023 吉林中考：中心对称"], pitfall: "对称后开口方向判断错", difficulty: "中", manim: "抛物线关于直线镜像翻转动画" },
    ],
  },
  {
    no: 15, chapter: "第二十六章 二次函数", title: "二次函数与最值",
    boards: [
      { name: "线段最值", exam: "动点线段最值化二次函数", zhenti: ["2024 湖北黄石中考：竖线段最大值", "2023 湖南湘潭中考：线段和最值"], pitfall: "目标线段表达式建立错", difficulty: "中" },
      { name: "面积最值", exam: "面积函数化+区间最值", zhenti: ["2024 四川乐山中考：三角形面积最大值", "2023 湖北十堰中考：面积最值求点"], pitfall: "面积表达式漏 1/2 或绝对值", difficulty: "中" },
      { name: "将军饮马、胡不归最值", exam: "折线和最短=对称化直；胡不归带系数", zhenti: ["2024 陕西中考：将军饮马在抛物线上的应用", "2023 四川成都中考：胡不归模型 PA+k·PB"], pitfall: "胡不归系数 k 转化三角比时不会作垂线", difficulty: "难", manim: "将军饮马：对称点展开成直线求最短路动画" },
    ],
  },
  {
    no: 16, chapter: "第二十六章 二次函数", title: "二次函数与参数",
    boards: [
      { name: "点参与线参", exam: "设点参数与直线参数的表达与消元", zhenti: ["2024 湖北武汉中考：设点参 (t, at²+bt+c) 表达几何量", "2023 湖南长沙中考：线参 k 的处理"], pitfall: "参数设得不统一导致消元困难", difficulty: "中" },
      { name: "二次函数与和差定值", exam: "两量和/差为定值的证明与求值", zhenti: ["2024 江苏无锡中考：两线段和为定值", "2023 浙江宁波中考：和定值证明"], pitfall: "化简不到底看不出定值", difficulty: "难" },
      { name: "二次函数与积商定值", exam: "两量积/商为定值", zhenti: ["2024 湖北鄂州中考：线段积定值", "2023 四川德阳中考：商为定值"], pitfall: "积商化简时因式分解不出来", difficulty: "难" },
      { name: "二次函数与长度定值", exam: "动线段长度为定值", zhenti: ["2023 湖北随州中考：动弦长定值", "2024 贵州安顺中考：长度定值"], pitfall: "长度平方后处理更简便却不会转化", difficulty: "难" },
      { name: "二次函数与定直线", exam: "动点恒在定直线上", zhenti: ["2024 湖南益阳中考：交点轨迹为定直线", "2023 湖北荆州中考：定直线证明"], pitfall: "消参不彻底留参数", difficulty: "难" },
      { name: "二次函数与定点(一)双切类", exam: "两条切线条件推出过定点", zhenti: ["2024 湖北武汉中考：双切线过定点", "2023 湖北黄冈中考：切线类定点"], pitfall: "切线条件（Δ=0）不会列", difficulty: "难" },
      { name: "二次函数与定点(二)线束类", exam: "直线束恒过定点提参数", zhenti: ["2024 山东潍坊中考：含参直线过定点", "2023 湖北咸宁中考：线束定点"], pitfall: "提参数后系数为零的方程组不会列", difficulty: "中" },
      { name: "二次函数与定点(三)平四类", exam: "平行四边形类条件推定点", zhenti: ["2024 湖北孝感中考：平四顶点过定点", "2022 湖北恩施中考：平四类"], pitfall: "中点公式用错对象", difficulty: "难" },
    ],
  },
  {
    no: 17, chapter: "第二十六章 二次函数", title: "抛物线与平行弦、相交弦",
    boards: [
      { name: "平行弦的有关性质", exam: "平行弦中点轨迹与对称轴关系", zhenti: ["2023 湖北武汉中考：平行弦中点性质", "2024 模拟联考高频：平行弦等长结论"], pitfall: "中点横坐标为定值的结论不会证", difficulty: "难" },
      { name: "平行弦性质的应用", exam: "用平行弦性质简化计算", zhenti: ["2024 湖北联考：平行弦应用求参数", "2023 湖北黄石中考：性质应用"], pitfall: "性质条件（弦平行）验证遗漏", difficulty: "难" },
      { name: "相交弦的有关性质", exam: "抛物线内相交弦的比例性质", zhenti: ["2024 湖北襄阳联考：相交弦比例", "2023 模拟：相交弦定值"], pitfall: "比例方向写反", difficulty: "难" },
      { name: "相交弦性质的应用", exam: "相交弦性质求定值定点", zhenti: ["2024 湖北荆州联考：相交弦应用", "2023 湖北联考：综合应用"], pitfall: "性质与韦达定理结合时符号错", difficulty: "难" },
    ],
  },
  {
    no: 18, chapter: "第二十六章 二次函数", title: "抛物线与焦点、准线",
    boards: [
      { name: "焦点、准线(一)", exam: "焦点准线定义与基本量（新定义题热点）", zhenti: ["2024 湖北武汉四调：焦点准线新定义", "2023 湖南长沙模拟：定义运用"], pitfall: "到焦点距离=到准线距离的定义用错对象", difficulty: "难", manim: "抛物线作为焦点准线等距点轨迹的生成动画" },
      { name: "焦点、准线(二)", exam: "焦点弦性质", zhenti: ["2024 湖北联考：焦点弦长", "2023 模拟：焦点弦性质"], pitfall: "焦半径公式记错", difficulty: "难" },
      { name: "焦点、准线(三)", exam: "焦点准线综合应用", zhenti: ["2024 湖北黄冈模拟：焦点准线综合", "2023 武汉模拟：最值应用"], pitfall: "定义与函数性质结合时转化不熟", difficulty: "难" },
    ],
  },
  {
    no: 19, chapter: "第二十六章 二次函数", title: "抛物线与阿基米德三角形",
    boards: [
      { name: "阿基米德三角形的性质", exam: "切点弦三角形（阿氏三角形）的顶点与中线性质", zhenti: ["2024 湖北武汉中考模拟：阿氏三角形顶点坐标", "2023 湖北联考：中线性质"], pitfall: "阿氏三角形定义（两切线+切点弦）记错", difficulty: "难", manim: "两切线与切点弦围成阿基米德三角形的构造动画" },
      { name: "阿基米德三角形性质的应用", exam: "用性质求面积定值与最值", zhenti: ["2024 湖北联考：阿氏三角形面积定值", "2023 模拟：性质应用"], pitfall: "面积公式与切点弦方程不熟", difficulty: "难" },
    ],
  },
  {
    no: 20, chapter: "第二十七章 反比例函数", title: "反比例函数的定义、图象与性质",
    boards: [
      { name: "定义与图象", exam: "k 的符号与象限分布是必考基础", zhenti: ["2024 北京中考：反比例函数图象过点求 k", "2023 天津中考：象限判断"], pitfall: "xy=k 的等价形式不熟", difficulty: "易", manim: "k 正负变化时双曲线象限切换动画" },
      { name: "比较坐标的大小", exam: "同支/异支比较函数值大小", zhenti: ["2024 上海中考：三点纵坐标比较", "2023 重庆中考：含参比较"], pitfall: "异支比较忘用正负性", difficulty: "易" },
      { name: "求变量的取值范围", exam: "由不等式条件求 x 范围", zhenti: ["2023 河北中考：y₁>y₂ 求 x 范围", "2024 山西中考：图象法求范围"], pitfall: "忘记 x≠0 把区间断开", difficulty: "中" },
      { name: "反比例函数的轴对称性", exam: "双曲线关于 y=x、y=-x 及原点对称", zhenti: ["2024 山东中考：对称点坐标", "2023 河南中考：中心对称应用"], pitfall: "关于 y=-x 对称的坐标变换写错", difficulty: "中", manim: "双曲线关于原点中心对称的旋转动画" },
    ],
  },
  {
    no: 21, chapter: "第二十七章 反比例函数", title: "反比例函数小综合",
    boards: [
      { name: "k 的几何意义(一)单反比例函数", exam: "|k|=矩形面积是中考年年考", zhenti: ["2024 江苏中考：矩形面积求 k", "2023 浙江中考：三角形面积=|k|/2"], pitfall: "k 的符号由象限定，面积只是 |k|", difficulty: "中", manim: "点在双曲线上滑动时矩形面积恒为 |k| 的动画" },
      { name: "k 的几何意义(二)双反比例函数", exam: "两双曲线围成面积=k 之差", zhenti: ["2024 湖北中考：双曲线间面积", "2023 湖南中考：k₁-k₂ 模型"], pitfall: "两 k 相减方向错", difficulty: "中" },
      { name: "点参法与面积", exam: "设点参 (t, k/t) 表达面积", zhenti: ["2024 四川中考：点参法求面积最值", "2023 湖北中考：点参表达"], pitfall: "点参代换后面积符号不分象限", difficulty: "难" },
      { name: "反比例函数与方程、不等式", exam: "交点↔方程、图象↔不等式", zhenti: ["2024 广东中考：交点个数", "2023 福建中考：不等式解集"], pitfall: "联立后 x≠0 的增根不剔", difficulty: "中" },
      { name: "反比例函数与一次函数结合", exam: "交点、不等式、面积综合", zhenti: ["2024 湖北武汉中考：一次+反比例综合", "2023 安徽中考：交点三角形面积"], pitfall: "交点坐标用韦达定理整体处理不熟", difficulty: "中" },
      { name: "反比例函数与中点问题", exam: "中点坐标结合 k 的几何意义", zhenti: ["2024 江西中考：中点条件求 k", "2023 云南中考：中点模型"], pitfall: "中点公式与 k 关系推导错", difficulty: "中" },
      { name: "反比例函数与横平竖直线", exam: "横竖线与双曲线交点的面积模型", zhenti: ["2024 陕西中考：横竖线围成面积", "2023 甘肃中考：矩形模型"], pitfall: "交点顺序与边长正负号错", difficulty: "中" },
      { name: "反比例函数与特殊四边形", exam: "矩形/菱形/平行四边形顶点在双曲线上", zhenti: ["2024 湖南中考：矩形顶点求 k", "2023 辽宁中考：平行四边形"], pitfall: "对称性利用不充分导致方程过多", difficulty: "难" },
    ],
  },
  {
    no: 22, chapter: "第二十八章 旋转", title: "旋转的性质",
    boards: [
      { name: "知旋转求角度", exam: "旋转角=对应点与中心连线夹角", zhenti: ["2024 天津中考：旋转求角度", "2023 北京中考：旋转角计算"], pitfall: "旋转角与图形内角混淆", difficulty: "易", manim: "三角形绕点旋转、对应边夹角等于旋转角动画" },
      { name: "知旋转求长度", exam: "旋转保距：对应线段相等", zhenti: ["2024 河北中考：旋转求线段长", "2023 山西中考：旋转+勾股"], pitfall: "对应边找错", difficulty: "易" },
      { name: "分类讨论求角度", exam: "旋转方向/落点不定要分类", zhenti: ["2024 辽宁中考：旋转落点分类求角", "2023 吉林中考：顺逆分类"], pitfall: "只按顺时针算漏逆时针", difficulty: "中" },
      { name: "分类讨论求长度", exam: "多种落点情形求长度", zhenti: ["2024 黑龙江中考：分类求长度", "2023 内蒙古中考：多解情形"], pitfall: "漏掉共线退化情形", difficulty: "中" },
      { name: "坐标系中的旋转", exam: "90°/180° 旋转坐标变换公式", zhenti: ["2024 山东中考：绕原点旋转 90° 坐标", "2023 河南中考：旋转坐标"], pitfall: "(a,b) 绕原点逆 90° 为 (-b,a)，方向记反", difficulty: "中", manim: "坐标系中点绕原点 90° 旋转轨迹动画" },
      { name: "双曲线的中心对称性", exam: "双曲线关于原点中心对称与旋转结合", zhenti: ["2024 湖北中考：双曲线+旋转", "2023 湖南中考：中心对称"], pitfall: "对称点坐标求错", difficulty: "中" },
    ],
  },
  {
    no: 23, chapter: "第二十八章 旋转", title: "实践操作——与旋转有关的作图",
    boards: [
      { name: "尺规作图(一)作旋转", exam: "尺规作出旋转后的图形", zhenti: ["2024 江苏南京中考：尺规作旋转", "2023 浙江杭州中考：作图+证明"], pitfall: "旋转中心与角度在作图中体现不全", difficulty: "中" },
      { name: "尺规作图(二)用旋转", exam: "利用旋转作辅助图形解题", zhenti: ["2024 北京中考：旋转作图求最值", "2023 上海中考：旋转构造"], pitfall: "旋转对象选择不当", difficulty: "难" },
      { name: "无刻度直尺作图(一)巧画旋转", exam: "仅用无刻度直尺借网格作旋转", zhenti: ["2024 湖北武汉中考：网格中无刻度直尺作旋转 90°", "2023 湖北黄冈中考：直尺作图"], pitfall: "网格对角线利用不熟", difficulty: "难" },
      { name: "无刻度直尺作图(二)活用旋转", exam: "旋转思想直尺作图进阶", zhenti: ["2024 湖北宜昌中考：活用旋转作图", "2023 湖北荆州中考：作图综合"], pitfall: "辅助点找不准", difficulty: "难" },
    ],
  },
  {
    no: 24, chapter: "第二十八章 旋转", title: "旋转模型",
    boards: [
      { name: "再识手拉手模型", exam: "共顶点等线段+等角→全等的手拉手", zhenti: ["2024 山东济南中考：手拉手全等", "2023 河北中考：手拉手线段关系"], pitfall: "旋转方向与全等对应关系错", difficulty: "中", manim: "手拉手模型：两个等边三角形共顶点旋转的全等动画" },
      { name: "再识手拉脚模型", exam: "共顶点旋转线段端点连线关系", zhenti: ["2024 四川中考：手拉脚模型", "2023 重庆中考：模型运用"], pitfall: "夹角关系推导错", difficulty: "中" },
      { name: "再识脚拉脚模型", exam: "中点+旋转的脚拉脚模型", zhenti: ["2024 湖北中考：脚拉脚中点模型", "2023 湖南中考：中点连线"], pitfall: "中位线关系找不到", difficulty: "难" },
      { name: "再识半角模型", exam: "半角模型旋转补短", zhenti: ["2024 湖北武汉中考：正方形半角模型", "2023 江苏中考：半角旋转"], pitfall: "补短后三点共线不证明", difficulty: "难", manim: "半角模型：将三角形旋转拼合的动画" },
    ],
  },
  {
    no: 25, chapter: "第二十八章 旋转", title: "旋转构造",
    boards: [
      { name: "遇60°旋转60°构全等", exam: "60°角条件旋转构等边", zhenti: ["2024 湖北中考：60°旋转构造", "2023 广东中考：等边构造"], pitfall: "旋转方向选错导致构造失败", difficulty: "难", manim: "绕 60° 顶点旋转拼出等边三角形动画" },
      { name: "遇90°旋转90°构全等", exam: "直角条件旋转构正方形/等直", zhenti: ["2024 湖北黄冈中考：90°旋转", "2023 湖北宜昌中考：直角构造"], pitfall: "旋转后重合边不验证", difficulty: "难" },
      { name: "遇120°旋转120°构全等", exam: "120°条件旋转构造", zhenti: ["2024 模拟联考：120°旋转", "2023 湖北联考：构造应用"], pitfall: "120°等腰条件不会用", difficulty: "难" },
      { name: "遇中点旋转180°构全等", exam: "中点条件倍长中线=180°旋转", zhenti: ["2024 湖北咸宁中考：倍长中线", "2023 湖北孝感中考：中点旋转"], pitfall: "倍长后全等对应错", difficulty: "中", manim: "倍长中线即绕中点 180° 旋转的动画" },
    ],
  },
  {
    no: 26, chapter: "第二十八章 旋转", title: "旋转中的路径与最值",
    boards: [
      { name: "旋转路径", exam: "旋转路径是圆弧，弧长计算", zhenti: ["2024 辽宁中考：旋转路径弧长", "2023 吉林中考：扫过面积"], pitfall: "半径找错（到旋转中心距离）", difficulty: "中", manim: "点绕中心旋转扫出圆弧的动画" },
      { name: "旋转最值(一)垂线段最短", exam: "动点轨迹为圆时垂线段最短", zhenti: ["2024 湖北中考：圆轨迹垂线段最短", "2023 陕西中考：点到直线距离"], pitfall: "看不出动点轨迹是圆", difficulty: "难" },
      { name: "旋转最值(二)两点之间线段最短", exam: "旋转化折为直求最值", zhenti: ["2024 湖北武汉中考：旋转化直求最值", "2023 湖南中考：线段和最值"], pitfall: "旋转目标选择不当", difficulty: "难", manim: "旋转把折线拉直的求最值动画" },
      { name: "旋转最值(三)函数建模", exam: "旋转中变量关系函数化求最值", zhenti: ["2024 湖北联考：旋转+二次函数最值", "2023 湖北联考：函数建模"], pitfall: "自变量范围由几何约束定，易漏", difficulty: "难" },
    ],
  },
  {
    no: 27, chapter: "第二十九章 圆", title: "圆的有关性质(一)",
    boards: [
      { name: "半径的运用(一)构等腰、构全等", exam: "连半径构等腰三角形是圆中第一辅助线", zhenti: ["2024 天津中考：连半径求角度", "2023 河北中考：半径构全等"], pitfall: "半径相等条件不会转化为等腰", difficulty: "中", manim: "连半径出现等腰三角形的构造动画" },
      { name: "半径的运用(二)作隐圆", exam: "定点定长作隐圆解决动点问题", zhenti: ["2024 湖北武汉中考：隐圆求最值", "2023 江苏中考：隐圆存在性"], pitfall: "识别不出「到定点距离定长」", difficulty: "难", manim: "动点到定点距离不变描出隐圆的动画" },
      { name: "垂径定理(一)构单弦心距", exam: "垂径定理+勾股算弦长是必考", zhenti: ["2024 北京中考：弦心距求弦长", "2023 上海中考：垂径定理"], pitfall: "弦心距、半径、半弦的直角三角形找错", difficulty: "中", manim: "圆心向弦作垂线平分弦的动态演示" },
      { name: "垂径定理(二)构双弦心距", exam: "两弦问题双弦心距模型", zhenti: ["2024 湖北中考：双弦心距", "2023 湖南中考：两弦距离"], pitfall: "两弦在圆心同侧异侧分类漏", difficulty: "难" },
    ],
  },
  {
    no: 28, chapter: "第二十九章 圆", title: "圆的有关性质(二)",
    boards: [
      { name: "弧的中点(一)连圆心构垂径", exam: "弧中点连圆心垂直平分弦", zhenti: ["2024 山东中考：弧中点性质", "2023 河南中考：垂径推论"], pitfall: "弧中点与弦中点关系搞混", difficulty: "中" },
      { name: "弧的中点(二)连端点构等腰", exam: "弧中点连弦端点得等腰", zhenti: ["2024 湖北中考：弧中点等腰", "2023 安徽中考：等弧等弦"], pitfall: "等弧对等弦方向用反", difficulty: "中" },
      { name: "直径的构造", exam: "见直角想直径、见直径想直角", zhenti: ["2024 湖北武汉中考：构造直径", "2023 四川中考：90°圆周角"], pitfall: "直径所对圆周角为直角的逆用不熟", difficulty: "中", manim: "直径所对圆周角恒为 90° 的动画（泰勒斯定理）" },
      { name: "圆内接四边形的构造", exam: "对角互补构圆内接四边形", zhenti: ["2024 湖北中考：四点共圆", "2023 福建中考：对角互补"], pitfall: "四点共圆判定条件列错", difficulty: "难" },
    ],
  },
  {
    no: 29, chapter: "第二十九章 圆", title: "圆的有关计算",
    boards: [
      { name: "弧长计算", exam: "l=nπr/180 弧长公式直接考", zhenti: ["2024 河北中考：弧长计算", "2023 山西中考：弧长+旋转"], pitfall: "圆心角度数找错", difficulty: "易" },
      { name: "扇形面积计算", exam: "S=nπr²/360 与弓形面积", zhenti: ["2024 河南中考：扇形面积", "2023 陕西中考：阴影弓形"], pitfall: "弓形=扇形-三角形的组合不熟", difficulty: "易", manim: "扇形展开与面积占比动画" },
      { name: "圆锥的有关计算", exam: "圆锥侧面展开扇形：母线=半径、底面周长=弧长", zhenti: ["2024 辽宁中考：圆锥侧面积", "2023 吉林中考：展开图圆心角"], pitfall: "底面半径与展开扇形半径混淆", difficulty: "中", manim: "圆锥侧面展开成扇形的动画" },
    ],
  },
  {
    no: 30, chapter: "第三十章 直线与圆的位置关系", title: "切线的判定与性质",
    boards: [
      { name: "切线的判定", exam: "「有交点连半径证垂直、无交点作垂直证半径」两大路径", zhenti: ["2024 湖北武汉中考：切线判定证明", "2023 湖南长沙中考：判定+计算"], pitfall: "两种判定路径混用导致证明缺步", difficulty: "中", manim: "直线靠近圆到相切瞬间半径垂直切线的动画" },
      { name: "切线的性质(一)单切", exam: "切线垂直于过切点的半径", zhenti: ["2024 北京中考：切线性质求角度", "2023 天津中考：单切模型"], pitfall: "切线长与半径关系用错", difficulty: "中" },
      { name: "切线的性质(二)双切", exam: "切线长定理：两切线相等+连心线平分两切线夹角", zhenti: ["2024 湖北中考：双切线求长度", "2023 四川中考：切线长定理"], pitfall: "切线长相等的条件（同一点引出）不注意", difficulty: "中", manim: "圆外一点引两条切线等长的动画" },
      { name: "切线的性质(三)多切", exam: "多切线组合与切点连线", zhenti: ["2024 湖北黄冈中考：多切模型", "2023 湖北宜昌中考：切点三角形"], pitfall: "多组切线长关系理不清", difficulty: "难" },
    ],
  },
  {
    no: 31, chapter: "第三十章 直线与圆的位置关系", title: "圆中的基本图形研究",
    boards: [
      { name: "垂径图", exam: "垂径图基本量关系一网打尽", zhenti: ["2024 湖北中考：垂径图综合", "2023 湖北咸宁中考：基本量"], pitfall: "图中多个直角三角形关系理不清", difficulty: "中" },
      { name: "角分图", exam: "角平分线+圆的组合图形", zhenti: ["2024 湖北荆州中考：角分图", "2023 湖北随州中考：角平分线"], pitfall: "角平分线性质与圆周角结合不熟", difficulty: "中" },
      { name: "折弦图", exam: "折弦定理（阿基米德折弦）", zhenti: ["2024 湖北联考：折弦定理", "2023 模拟：折弦图"], pitfall: "折弦中点条件不会用", difficulty: "难" },
      { name: "等腰图(一)圆心在对称轴上", exam: "等腰三角形与圆心共轴", zhenti: ["2024 湖北中考：圆心在对称轴", "2023 湖北孝感中考：等腰图"], pitfall: "对称性条件不会转化为垂直平分", difficulty: "中" },
      { name: "等腰图(二)圆心在腰上", exam: "圆心在等腰三角形腰上的模型", zhenti: ["2024 湖北黄冈中考：圆心在腰", "2023 湖北鄂州中考：模型运用"], pitfall: "圆心位置带来的角度关系找错", difficulty: "难" },
      { name: "切割图", exam: "切割线定理图形", zhenti: ["2024 湖北中考：切割线定理", "2023 湖北恩施中考：切线+割线"], pitfall: "切割线定理比例式写错", difficulty: "难" },
      { name: "双切图", exam: "双切线图形的全部结论", zhenti: ["2024 湖北武汉中考：双切图结论", "2023 湖北十堰中考：双切综合"], pitfall: "双切+弦的组合角度关系多,易漏", difficulty: "难" },
      { name: "三角形内切圆", exam: "内切圆半径 r=S/s 与切线长模型", zhenti: ["2024 湖北中考：内切圆半径", "2023 湖南中考：切线长求边"], pitfall: "r=S/s 公式中 s 为半周长记错", difficulty: "中", manim: "三角形内切圆与三边相切、切点分边长的动画" },
      { name: "梯切圆", exam: "梯形内切圆（圆外切四边形）", zhenti: ["2024 湖北联考：圆外切梯形", "2023 模拟：对边和相等"], pitfall: "圆外切四边形对边和相等不会用", difficulty: "难" },
      { name: "内心图", exam: "内心角度公式 ∠BIC=90°+A/2", zhenti: ["2024 湖北中考：内心角度", "2023 湖北荆门中考：内心性质"], pitfall: "内心角度公式记错", difficulty: "中" },
    ],
  },
  {
    no: 32, chapter: "第三十章 直线与圆的位置关系", title: "圆与图形变换",
    boards: [
      { name: "圆的翻折", exam: "圆中翻折（轴对称）求弦与角", zhenti: ["2024 湖北中考：圆的翻折", "2023 湖北仙桃中考：折叠圆弧"], pitfall: "翻折后对应弧/弦关系找错", difficulty: "难" },
      { name: "圆的旋转", exam: "圆绕点旋转的位置关系变化", zhenti: ["2024 湖北联考：圆的旋转", "2023 湖北模拟：旋转相切"], pitfall: "旋转中圆心轨迹是圆弧想不到", difficulty: "难", manim: "圆绕定点旋转、圆心轨迹动画" },
    ],
  },
  {
    no: 33, chapter: "第三十章 直线与圆的位置关系", title: "圆的有关计算（正多边形/覆盖/截取）",
    boards: [
      { name: "正多边形的有关计算", exam: "正多边形中心角、边心距、半径", zhenti: ["2024 河北中考：正六边形计算", "2023 山西中考：边心距"], pitfall: "中心角=360°/n 与外角混淆", difficulty: "中" },
      { name: "圆的覆盖", exam: "最小覆盖圆问题", zhenti: ["2024 湖北联考：覆盖圆", "2023 模拟：最小圆"], pitfall: "钝角三角形最小覆盖圆以最长边为直径", difficulty: "难" },
      { name: "圆的截取", exam: "圆中截取最大图形", zhenti: ["2024 湖北模拟：截取问题", "2023 联考：最大矩形"], pitfall: "最值条件转化不到半径约束", difficulty: "难" },
    ],
  },
  {
    no: 34, chapter: "第三十章 直线与圆的位置关系", title: "实践操作——与圆有关的作图",
    boards: [
      { name: "尺规作图(一)知圆", exam: "已知圆作切线/垂径", zhenti: ["2024 江苏中考：作圆的切线", "2023 浙江中考：尺规作图"], pitfall: "作图痕迹与依据不对应", difficulty: "中" },
      { name: "尺规作图(二)作圆", exam: "过点作圆/找圆心", zhenti: ["2024 北京中考：作圆过三点", "2023 上海中考：找圆心"], pitfall: "中垂线交点找圆心步骤不全", difficulty: "中" },
      { name: "无刻度直尺作图(一)无心之圆", exam: "无圆心时用直尺找直径/圆心", zhenti: ["2024 湖北武汉中考：无心圆作图", "2023 湖北黄冈中考：直尺找圆心"], pitfall: "90°圆周角找直径不会用", difficulty: "难" },
      { name: "无刻度直尺作图(二)圆之中点", exam: "直尺作弧/弦中点", zhenti: ["2024 湖北宜昌中考：作中点", "2023 湖北荆州中考：直尺作图"], pitfall: "对称性利用不熟", difficulty: "难" },
      { name: "无刻度直尺作图(三)角、弧、弦", exam: "直尺作角弧弦的等量关系", zhenti: ["2024 湖北联考：角弧弦作图", "2023 湖北模拟：综合作图"], pitfall: "等弧等角转化不熟", difficulty: "难" },
    ],
  },
  {
    no: 35, chapter: "第三十章 直线与圆的位置关系", title: "圆中的最值",
    boards: [
      { name: "经过定点的弦", exam: "过定点弦长最值（直径最长、垂直最短）", zhenti: ["2024 湖北武汉中考：过定点弦最值", "2023 湖北襄阳中考：弦长范围"], pitfall: "最短弦=与OP垂直的弦不知道", difficulty: "中", manim: "弦绕过圆内定点旋转、弦长变化的动画" },
      { name: "「定点定长」型隐圆", exam: "定点定长判隐圆求最值", zhenti: ["2024 湖北中考：定点定长隐圆", "2023 湖北孝感中考：隐圆最值"], pitfall: "隐圆条件识别不出", difficulty: "难" },
      { name: "显性「定弦定角」型隐圆", exam: "定弦对定角→动点在两段弧上", zhenti: ["2024 湖北黄冈中考：定弦定角", "2023 湖北咸宁中考：隐圆轨迹"], pitfall: "定角对应两段弧只画一段", difficulty: "难", manim: "定弦定角动点描出圆弧轨迹的动画" },
      { name: "隐性「定弦定角」型隐圆", exam: "角度条件隐藏需先推出定角", zhenti: ["2024 湖北联考：隐性定弦定角", "2023 湖北模拟：隐圆进阶"], pitfall: "定角条件隐藏深推不出", difficulty: "难" },
      { name: "隐圆隐切线", exam: "隐圆的切线条件求最值", zhenti: ["2024 湖北联考：隐圆切线", "2023 湖北模拟：切线最值"], pitfall: "切线条件与距离转化不熟", difficulty: "难" },
      { name: "「定角定高」类最值", exam: "定角定高求三角形面积/边最值", zhenti: ["2024 湖北中考：定角定高", "2023 湖北鄂州中考：面积最值"], pitfall: "定高对应外接圆模型想不到", difficulty: "难" },
    ],
  },
  {
    no: 36, chapter: "大综合", title: "旋转综合探究",
    boards: [
      { name: "特殊到一般(一)角度的特殊到一般", exam: "从特殊角到一般角的探究题", zhenti: ["2024 湖北武汉中考：角度探究", "2023 湖北黄冈中考：特殊到一般"], pitfall: "特殊情形的证明方法不能迁移到一般", difficulty: "难" },
      { name: "特殊到一般(二)图形的特殊到一般", exam: "从特殊图形到一般图形", zhenti: ["2024 湖北中考：图形探究", "2023 湖北宜昌中考：一般化"], pitfall: "结论在一般情形下不成立不会判断", difficulty: "难" },
      { name: "特殊到一般(三)位置的特殊到一般", exam: "从特殊位置到一般位置", zhenti: ["2024 湖北联考：位置探究", "2023 湖北模拟：位置变化"], pitfall: "位置变化后图形的对应关系错乱", difficulty: "难" },
      { name: "旋转模型(一)构双等边三角形", exam: "构双等边的旋转综合", zhenti: ["2024 湖北中考：双等边", "2023 湖北荆州中考：等边构造"], pitfall: "双等边的旋转对应找错", difficulty: "难" },
      { name: "旋转模型(二)构双等腰直角三角形", exam: "双等腰直角模型", zhenti: ["2024 湖北联考：双等直", "2023 湖北模拟：等直模型"], pitfall: "45°关系链推导错", difficulty: "难" },
      { name: "旋转模型(三)中点模型", exam: "中点+旋转综合模型", zhenti: ["2024 湖北中考：中点模型", "2023 湖北孝感中考：中点旋转"], pitfall: "中位线+旋转双重关系不会叠加", difficulty: "难" },
      { name: "旋转模型(四)夹半角模型", exam: "夹半角旋转补短综合", zhenti: ["2024 湖北武汉中考：夹半角", "2023 湖北黄石中考：半角综合"], pitfall: "补短后全等与二次全等链长", difficulty: "难" },
      { name: "类比推理(一)模型应用", exam: "把已证模型类比到新情境", zhenti: ["2024 湖北中考：模型类比", "2023 湖北十堰中考：应用迁移"], pitfall: "模型条件在新情境中不满足却硬套", difficulty: "难" },
      { name: "类比推理(二)方法迁移", exam: "方法层面的迁移探究", zhenti: ["2024 湖北联考：方法迁移", "2023 湖北模拟：探究题"], pitfall: "迁移时条件差异分析不到位", difficulty: "难" },
    ],
  },
  {
    no: 37, chapter: "大综合", title: "二次函数综合探究",
    boards: [
      { name: "二次函数与定值(一)线段积为定值", exam: "线段积定值的证明与运用", zhenti: ["2024 湖北武汉中考：线段积定值", "2023 湖北黄冈中考：定值证明"], pitfall: "设参后化简不到底", difficulty: "难" },
      { name: "二次函数与定值(二)面积为定值", exam: "面积定值问题", zhenti: ["2024 湖北中考：面积定值", "2023 湖北宜昌中考：定值探究"], pitfall: "面积表达式建立错误", difficulty: "难" },
      { name: "二次函数与定点(一)线段积得定点", exam: "由线段积关系推定点", zhenti: ["2024 湖北联考：线段积定点", "2023 湖北模拟：定点问题"], pitfall: "积关系转化坐标方程出错", difficulty: "难" },
      { name: "二次函数与定点(二)平行线得定点", exam: "平行线束条件推定点", zhenti: ["2024 湖北中考：平行线定点", "2023 湖北荆州中考：定点证明"], pitfall: "平行条件（斜率相等）列错", difficulty: "难" },
      { name: "二次函数与最值", exam: "二次函数最值综合题", zhenti: ["2024 湖北武汉中考：综合最值", "2023 湖北襄阳中考：多段最值"], pitfall: "多量最值的主元选择不当", difficulty: "难" },
      { name: "二次函数与参数", exam: "含参二次函数综合探究", zhenti: ["2024 湖北中考：含参综合", "2023 湖北咸宁中考：参数范围"], pitfall: "参数讨论层次不清", difficulty: "难" },
    ],
  },
];

// ── 账号视角模板 ─────────────────────────────────────────────────────────

const ACCOUNTS = {
  second: {
    displayName: "巧思初数",
    angle: (b: Board, lec: Lecture) =>
      `【教学视角】${lec.chapter}·第${lec.no}讲：${b.name}是中考${b.exam}的典型考点。本篇从知识点本质讲起，配历年真题拆解，帮孩子把「${b.pitfall}」这类易错点一次讲透。`,
    title: (b: Board) => `九上必考｜${b.name}：知识点精讲 + 中考真题拆解（附易错警示）`,
    titleSummary: (lec: Lecture) => `第${lec.no}讲总结｜${lec.title}：知识地图 + 中考真题串讲 + 易错清单`,
  },
  gaoh: {
    displayName: "gaoh的技术分享",
    angle: (b: Board, lec: Lecture) =>
      `【技术视角】用结构化方法拆解${lec.chapter}·第${lec.no}讲的「${b.name}」：把考点抽象成可复用的解题模型，配合真题数据验证，重点解决「${b.pitfall}」。`,
    title: (b: Board) => `拆解九上数学｜${b.name} 的通用解法框架（真题验证）`,
    titleSummary: (lec: Lecture) => `复盘｜${lec.title} 完整知识框架与题型模型库（第${lec.no}讲）`,
  },
} as const;

// ── 日期工具（本地实现，避免依赖引擎 import 路径） ───────────────────────

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayCn(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getUTCDay()];
}

/** ISO-8601 week key, e.g. 2026-W42（周四归周规则） */
function isoWeek(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // 本周周四
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// ── 生成 ─────────────────────────────────────────────────────────────────

interface PlanDay {
  date: string;
  weekday: string;
  module: string;
  lecture: number;
  board: string;
  isSummary: boolean;
  topic: string;
  grade: string;
  difficulty: string;
  angle: string;
  titleSuggestion: string;
  outline: string[];
  manimHint?: string;
}

function buildDay(b: Board, lec: Lecture, date: string, account: keyof typeof ACCOUNTS): PlanDay {
  const tpl = ACCOUNTS[account];
  const outline = [
    `知识点精讲：${b.name}的核心概念、公式与适用条件，配合图示逐步推导。`,
    `中考定位：${b.exam}，说明该板块在中考中的题型分布与分值占比。`,
    `真题拆解 1：${b.zhenti[0]}——审题→考点定位→规范解答→评分点。`,
    `真题拆解 2：${b.zhenti[1]}——拆出命题人考查的知识组合与常见变式。`,
    `易错警示：${b.pitfall}，给出针对性的检查清单。`,
    `变式训练：基于本板块方法的 1~2 道进阶练习（附提示）。`,
  ];
  return {
    date,
    weekday: weekdayCn(date),
    module: `${lec.chapter}·第${lec.no}讲 ${lec.title}`,
    lecture: lec.no,
    board: b.name,
    isSummary: false,
    topic: `${lec.chapter} 第${lec.no}讲｜${b.name}（${b.exam}）`,
    grade: "九年级",
    difficulty: b.difficulty,
    angle: tpl.angle(b, lec),
    titleSuggestion: tpl.title(b),
    outline,
    ...(b.manim ? { manimHint: b.manim } : {}),
  };
}

function buildSummaryDay(lec: Lecture, date: string, account: keyof typeof ACCOUNTS): PlanDay {
  const tpl = ACCOUNTS[account];
  const boardList = lec.boards.map((b, i) => `板块${"一二三四五六七八九十"[i] ?? i + 1}「${b.name}」`).join("、");
  return {
    date,
    weekday: weekdayCn(date),
    module: `${lec.chapter}·第${lec.no}讲 ${lec.title}`,
    lecture: lec.no,
    board: "本讲汇总",
    isSummary: true,
    topic: `${lec.chapter} 第${lec.no}讲汇总｜${lec.title} 知识地图与中考真题串讲`,
    grade: "九年级",
    difficulty: "中",
    angle: tpl.angle(
      { name: `${lec.title}（汇总）`, exam: "整讲知识串联与综合应用", zhenti: [], pitfall: "知识点割裂、综合题不会拆", difficulty: "中" },
      lec,
    ),
    titleSuggestion: tpl.titleSummary(lec),
    outline: [
      `本讲知识地图：${boardList}，一张图理清讲内逻辑关系。`,
      `核心方法串联：把本讲 ${lec.boards.length} 个板块的方法归纳为 2~3 个通用模型。`,
      `中考真题串讲：选取覆盖本讲多板块的 2 道综合真题（标注年份地区），演示「拆题→定位板块→调用模型」全过程。`,
      `易错清单汇总：本讲各板块易错点合集，附自检问题。`,
      `承上启下：本讲与前后讲的衔接关系，预告下一讲内容。`,
    ],
  };
}

function generate(account: keyof typeof ACCOUNTS): PlanDay[] {
  const days: PlanDay[] = [];
  let i = 0;
  for (const lec of LECTURES) {
    for (const b of lec.boards) {
      days.push(buildDay(b, lec, addDays(START, i++), account));
    }
    days.push(buildSummaryDay(lec, addDays(START, i++), account));
  }
  return days;
}

// ── 校验 ─────────────────────────────────────────────────────────────────

function validate(days: PlanDay[]): string[] {
  const errors: string[] = [];
  const expected = LECTURES.reduce((s, l) => s + l.boards.length + 1, 0);
  if (days.length !== expected) errors.push(`总天数应为 ${expected}（171板块+37汇总），实际 ${days.length}`);
  days.forEach((d, i) => {
    const expect = addDays(START, i);
    if (d.date !== expect) errors.push(`第 ${i + 1} 天日期断档：期望 ${expect}，实际 ${d.date}`);
  });
  // 汇总篇位置：每讲最后一篇
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const next = days[i + 1];
    if (d.isSummary && next && next.lecture === d.lecture) errors.push(`${d.date} 汇总篇后仍是第${d.lecture}讲`);
    if (!d.isSummary && next && next.lecture !== d.lecture && !days[i].isSummary) {
      // 讲切换前的最后一篇必须是汇总
      if (!next.isSummary && next.lecture !== d.lecture) errors.push(`${d.date} 第${d.lecture}讲缺少汇总篇`);
    }
  }
  const summaryCount = days.filter((d) => d.isSummary).length;
  if (summaryCount !== LECTURES.length) errors.push(`汇总篇应为 ${LECTURES.length} 篇，实际 ${summaryCount}`);
  return errors;
}

// ── 主流程 ───────────────────────────────────────────────────────────────

const checkOnly = process.argv.includes("--check");

for (const account of Object.keys(ACCOUNTS) as (keyof typeof ACCOUNTS)[]) {
  const days = generate(account);
  const errors = validate(days);
  if (errors.length) {
    console.error(`[${account}] 校验失败：`);
    errors.slice(0, 10).forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
  const first = days[0], last = days[days.length - 1];
  const weeks = new Set(days.map((d) => isoWeek(d.date)));
  console.log(`[${account}] ✓ ${days.length} 天（${first.date} ~ ${last.date}），${weeks.size} 周，汇总篇 ${days.filter((d) => d.isSummary).length} 篇，manim 篇 ${days.filter((d) => d.manimHint).length} 篇`);

  if (checkOnly) continue;

  // 按周分文件输出（与物化格式一致）
  const byWeek = new Map<string, PlanDay[]>();
  for (const d of days) {
    const w = isoWeek(d.date);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w)!.push(d);
  }
  const dir = path.join(OUT_DIR, account);
  fs.mkdirSync(dir, { recursive: true });
  for (const [week, weekDays] of [...byWeek.entries()].sort()) {
    const file = path.join(dir, `${week}.json`);
    const payload = {
      week,
      generatedAt: new Date().toISOString(),
      account,
      days: weekDays.map((d) => ({ ...d })),
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
  console.log(`[${account}] 已写入 ${byWeek.size} 个周计划文件 → ${dir}`);
}

console.log(checkOnly ? "CHECK OK" : "DONE");
