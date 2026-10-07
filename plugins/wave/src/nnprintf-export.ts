// NNPrintf.h 导出模板（源：主仓库 firmware/NNPrintf.h，改动后需重新生成——勿手改本文件）。
import type { FirmwareFile } from './types';

export const NNPRINTF_FILES: FirmwareFile[] = [
  {
    name: 'NNPrintf.h',
    text: `/*---------------------------------------------------------------------------
 * NNPrintf.h —— 嵌入式分级日志库（单头文件，纯 C99，C/C++ 工程均可直接包含）
 *
 * 特性
 *   1. 六级日志：TRACE / DEBUG / INFO / WARNING / ERROR / FATAL
 *   2. 双层等级开关：
 *        编译期  NNPRINTF_COMPILE_LEVEL —— 低于它的调用整体剔除（零代码零开销）
 *        运行期  nnprintf_set_level()  —— 不重新编译即可收紧输出
 *   3. 输出钩子 NNPRINTF_OUTPUT(line)：整行交给用户自填的发送函数，默认空
 *   4. 行前缀 [标签]--（与本人 reprintf.h 历史格式一致），上位机 NNSerialTool
 *      会按 [INFO]/[WARNING]/[ERROR] 等标签自动着色
 *   5. 可选：毫秒时间戳 / 文件行号 / ANSI 终端颜色（均默认关闭）
 *
 * 快速上手
 *   #define NNPRINTF_OUTPUT(line)  uart_send_line(line)   // 包含前定义，或直接改本文件
 *   #define NNPRINTF_GET_MS()      HAL_GetTick()          // 可选：启用时间戳
 *   #include "NNPrintf.h"
 *   NNPrintf(INFO, "温度 %.1f", t);      // [INFO]--温度 25.0
 *   NNPrintf(ERROR, "code=%d", e);       // [ERROR]--code=-1
 *   NNPrintf_INFO(...); NNPrintf_DEBUG(...); NNPrintf_WARNING(...); NNPrintf_ERROR(...); NNPrintf_FATAL(...); NNPrintf_TRACE(...);
 *
 *   ※ 需要输出 %f 时：
 *       Keil 请勾选 Options → Target → Use MicroLib 并确认 C 库支持 %f；
 *       不少精简 C 库默认把 %f 打成空，固件侧先用整数/定点值（_100x）最稳。
 *
 * 等级开关用法
 *   #define NNPRINTF_COMPILE_LEVEL NNPRINTF_LVL_INFO   // 包含前定义：INFO 及以上才编译
 *   nnprintf_set_level(NNPRINTF_LVL_ERROR);            // 运行期再收紧（仅当前编译单元）
 *---------------------------------------------------------------------------*/
#ifndef __NNPRINTF_H__
#define __NNPRINTF_H__

#include <stdarg.h>                                     //va_list / va_start
#include <stdint.h>                                     //uint8_t / uint32_t
#include <stdio.h>                                      //vsnprintf / snprintf

#ifdef __cplusplus
extern "C" {
#endif

/* ================= 用户配置区（包含前 #define 覆盖即可） ================= */

#ifndef NNPRINTF_COMPILE_LEVEL
#define NNPRINTF_COMPILE_LEVEL      NNPRINTF_LVL_TRACE  //编译期最高输出等级，默认全开
#endif

#ifndef NNPRINTF_OUTPUT
#define NNPRINTF_OUTPUT(line)       ((void)0)           /* ★用户自填：整行输出钩子，默认空 */
#endif

#ifndef NNPRINTF_LINE_SIZE
#define NNPRINTF_LINE_SIZE          256                 //单行组装缓冲（含前缀与行尾）
#endif

#ifndef NNPRINTF_EOL
#define NNPRINTF_EOL                "\\r\\n"              //行结束符（串口工具通用 CRLF）
#endif

#ifndef NNPRINTF_SEP
#define NNPRINTF_SEP                "--"                //标签后分隔符，[INFO]--xxx
#endif

/* #define NNPRINTF_ANSI_COLOR                        */ //启用 ANSI 颜色（仅 ANSI 终端有效）
/* #define NNPRINTF_WITH_LOCATION                     */ //前缀追加 [文件:行]
/* #define NNPRINTF_GET_MS()      HAL_GetTick()       */ //定义后自动带 [秒.毫秒] 时间戳

/* ============================ 等级常量 ============================ */
/* 数值必须从小到大：越严重越高，过滤只做 >= 比较一遍 */

#define NNPRINTF_LVL_TRACE          0                   //最细跟踪
#define NNPRINTF_LVL_DEBUG          1                   //调试
#define NNPRINTF_LVL_INFO           2                   //常规信息
#define NNPRINTF_LVL_WARN           3                   //告警
#define NNPRINTF_LVL_ERROR          4                   //错误
#define NNPRINTF_LVL_FATAL          5                   //致命
#define NNPRINTF_LVL_NONE           6                   //全关（运行期用）

/* 短等级名：NNPrintf(INFO, ...) 形态依赖它们；怕污染命名空间就在包含前
 * 定义 NNPRINTF_NO_SHORT_LEVELS，改用 NNPrintf_INFO(...) 便捷宏 */

#ifndef NNPRINTF_NO_SHORT_LEVELS
#define TRACE                       NNPRINTF_LVL_TRACE
#define DEBUG                       NNPRINTF_LVL_DEBUG
#define INFO                        NNPRINTF_LVL_INFO
#define WARNING                     NNPRINTF_LVL_WARN
#define ERROR                       NNPRINTF_LVL_ERROR
#define FATAL                       NNPRINTF_LVL_FATAL
#endif

/* ============================ 对外接口 ============================ */

/* 设置运行期输出下限（低于它的等级直接丢弃）；返回旧等级，便于临时切换后恢复。
 * 注意：单头文件实现，每个包含它的 .c 各有一份状态，跨编译单元不共享 */
static inline uint8_t nnprintf_set_level(uint8_t level);

/* ======================= 编译期等级分派 ======================= */
/* NNPrintf(INFO, ...) → NNPRINTF_SINK_INFO(...)：短名参与宏拼接，
 * 各 SINK 独立做编译期 #if——被剔除的调用连实参求值都不会发生。
 * __FILE__/__LINE__ 在宏层取（调用点）；函数体内取会变成头文件自己的位置 */

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_TRACE
#define NNPRINTF_SINK_TRACE(...)    nnprintf_line(NNPRINTF_LVL_TRACE, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_TRACE(...)    ((void)0)
#endif

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_DEBUG
#define NNPRINTF_SINK_DEBUG(...)    nnprintf_line(NNPRINTF_LVL_DEBUG, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_DEBUG(...)    ((void)0)
#endif

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_INFO
#define NNPRINTF_SINK_INFO(...)     nnprintf_line(NNPRINTF_LVL_INFO, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_INFO(...)     ((void)0)
#endif

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_WARN
#define NNPRINTF_SINK_WARNING(...)  nnprintf_line(NNPRINTF_LVL_WARN, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_WARNING(...)  ((void)0)
#endif

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_ERROR
#define NNPRINTF_SINK_ERROR(...)    nnprintf_line(NNPRINTF_LVL_ERROR, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_ERROR(...)    ((void)0)
#endif

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_FATAL
#define NNPRINTF_SINK_FATAL(...)    nnprintf_line(NNPRINTF_LVL_FATAL, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_FATAL(...)    ((void)0)
#endif

/* 核心入口：等级须传短名（INFO/DEBUG/...），实际是宏拼接分派 */
#define NNPrintf(lvl, ...)          NNPRINTF_SINK_##lvl(__VA_ARGS__)

/* 便捷宏：不想用短等级名时的等价写法 */
#define NNPrintf_TRACE(...)         NNPRINTF_SINK_TRACE(__VA_ARGS__)
#define NNPrintf_DEBUG(...)         NNPRINTF_SINK_DEBUG(__VA_ARGS__)
#define NNPrintf_INFO(...)          NNPRINTF_SINK_INFO(__VA_ARGS__)
#define NNPrintf_WARNING(...)       NNPRINTF_SINK_WARNING(__VA_ARGS__)
#define NNPrintf_ERROR(...)         NNPRINTF_SINK_ERROR(__VA_ARGS__)
#define NNPrintf_FATAL(...)         NNPRINTF_SINK_FATAL(__VA_ARGS__)

/* ============================ 实现 ============================ */

#if defined(__GNUC__) || defined(__clang__)
#define NNPRINTF_UNUSED             __attribute__((unused))
#else
#define NNPRINTF_UNUSED
#endif

static uint8_t nnprintf_level NNPRINTF_UNUSED = NNPRINTF_LVL_TRACE;  //运行期等级（每编译单元一份）

static inline uint8_t nnprintf_set_level(uint8_t level)
{
    uint8_t old = nnprintf_level;                       //备份旧等级
    nnprintf_level = level;                             //应用新等级
    return old;
}

/* 等级标签与 ANSI 颜色（下标 = 等级常量，运行期按数值索引——
 * 注意不能在这里用 ## 拼接：## 是预处理符，对函数的运行期形参无效） */
static const char *const NNPRINTF_UNUSED nnprintf_tags[6] = {
    "[TRACE]", "[DEBUG]", "[INFO]", "[WARNING]", "[ERROR]", "[FATAL]"
};

#if defined(NNPRINTF_ANSI_COLOR)
static const char *const NNPRINTF_UNUSED nnprintf_colors[6] = {
    "\\x1b[90m", "\\x1b[90m", "\\x1b[32m", "\\x1b[33m", "\\x1b[31m", "\\x1b[35m"  //灰灰绿黄红品
};
#define NNPRINTF_CLR_END            "\\x1b[0m"           //整行结束复位
#else
static const char *const NNPRINTF_UNUSED nnprintf_colors[6] = {
    "", "", "", "", "", ""                              //未启用 ANSI 颜色：全空串
};
#define NNPRINTF_CLR_END            ""
#endif

/* 拼接工具：把一段以 NUL 结尾的文本追加到行缓冲（超长静默截断） */
static inline int nnprintf_append(char *buf, int pos, int cap, const char *text)
{
    while(pos < cap - 1 && *text != '\\0')buf[pos++] = *text++;
    return pos;
}

/* 行组装与输出：前缀 → 正文 → 行尾，整行交给 NNPRINTF_OUTPUT。
 * file/line 由 SINK 宏在调用点注入（仅 NNPRINTF_WITH_LOCATION 启用时打印） */
static inline void nnprintf_line(uint8_t lvl, const char *file, int line, const char *fmt, ...)
{
    char buf[NNPRINTF_LINE_SIZE];
    int  pos = 0;
    int  cap = NNPRINTF_LINE_SIZE;
    va_list ap;

    if(fmt == NULL)return;
    if(lvl > NNPRINTF_LVL_FATAL)return;                 //非法等级防御
    if(lvl < nnprintf_level)return;                     //运行期等级过滤
#if !defined(NNPRINTF_WITH_LOCATION)
    (void)file;                                         //位置未启用：仅压栈传递不打印
    (void)line;
#endif

    buf[0] = '\\0';
#if defined(NNPRINTF_GET_MS)
    {
        uint32_t ms = (uint32_t)NNPRINTF_GET_MS();      //毫秒时基（用户注入）
        pos += snprintf(buf + pos, (size_t)(cap - pos), "[%u.%03u]", ms / 1000u, ms % 1000u);
        if(pos > cap - 1)pos = cap - 1;                 //vsnprintf 返回"应有长度"，截断即钳位
    }
#endif
    pos = nnprintf_append(buf, pos, cap, nnprintf_colors[lvl]); //ANSI 颜色（未启用为空）
    pos = nnprintf_append(buf, pos, cap, nnprintf_tags[lvl]);   //等级标签 [INFO] 等
    pos = nnprintf_append(buf, pos, cap, NNPRINTF_SEP);         //分隔符 --
#if defined(NNPRINTF_WITH_LOCATION)
    if(file != NULL)
        pos += snprintf(buf + pos, (size_t)(cap - pos), "[%s:%d]", file, line);
    if(pos > cap - 1)pos = cap - 1;                     //钳位，防下面负长度
#endif

    va_start(ap, fmt);
    pos += vsnprintf(buf + pos, (size_t)(cap - pos), fmt, ap);  //用户正文
    va_end(ap);

    /* 行尾永远完整：按 EOL 实际长度钳位，颜色复位不挤占行尾空间 */
    {
        const char *eol = NNPRINTF_EOL;
        int elen = (int)(sizeof(NNPRINTF_EOL) - 1);
        if(pos > cap - elen - 1)pos = cap - elen - 1;           //截断钳位
        pos = nnprintf_append(buf, pos, cap - elen, NNPRINTF_CLR_END);  //颜色复位（未启用为空）
        while(*eol != '\\0')buf[pos++] = *eol++;                 //完整写入行尾
        buf[pos] = '\\0';                                        //NUL 收尾
    }
    NNPRINTF_OUTPUT(buf);                               //★整行交给用户钩子
}

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif //__NNPRINTF_H__
`,
  },
];
