// 固件侧 NN-Wave 协议实现模板（随插件导出；与上位机解析器严格一致）。
// 零动态内存、MCU 无关（发送回调注入），STM32/HAL/GD32/ESP-IDF 直接可用。
import type { FirmwareFile } from './types';

export const FIRMWARE_FILES: FirmwareFile[] = [
  {
    name: 'nnwave.h',
    text: `/*
 * NN-Wave v1 —— 轻量二进制波形协议（发送端）
 * 本文件为纯 C99 代码，C 与 C++ 工程均可直接包含（声明已用 extern "C" 包裹）。
 * 帧格式: [AA 55][type][N][seq][float32×N 小端][CRC8]
 *   type 0x01 = 数据帧（N 个 float32）
 *   type 0x02 = 通道名元数据帧（payload 为若干 [len][utf8]，补 0x00 到 4N 字节）
 *   CRC8 多项式 0x07，初值 0x00，覆盖 type..data
 * 通道数上限：N 为 1 字节，协议/固件/上位机统一上限 64（NNWAVE_MAX_CHANNELS）
 * 上位机：NNSerialTool 波形插件（协议选 NN-Wave）
 */
#ifndef NNWAVE_H
#define NNWAVE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 通道数硬上限：帧内 N 字段 1 字节 + 上位机解析器同值校验，两端一致 */
#define NNWAVE_MAX_CHANNELS 64

typedef struct {
    int (*write)(const uint8_t *data, size_t len); /* 阻塞发送回调，返回 0 表示成功 */
    uint8_t seq;                                   /* 帧序号，自动递增（上位机据此统计丢帧） */
} nnwave_t;

/* 初始化：注入发送回调（如 HAL_UART_Transmit 的包装） */
int nnwave_init(nnwave_t *h, int (*write)(const uint8_t *data, size_t len));

/* 发送一帧数据：channels[0..count-1] 对应波形 CH1..CHn（count ≤ NNWAVE_MAX_CHANNELS） */
int nnwave_send(nnwave_t *h, const float *channels, uint8_t count);

/* （可选）发送通道名，波形图例将显示这些名字；上电时发一次即可 */
int nnwave_send_names(nnwave_t *h, const char *const *names, uint8_t count);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* NNWAVE_H */
`,
  },
  {
    name: 'nnwave.c',
    text: `#include "nnwave.h"

#include <string.h>

static uint8_t nnwave_crc8(const uint8_t *d, size_t n) {
    uint8_t crc = 0;
    while (n--) {
        crc ^= *d++;
        for (int i = 0; i < 8; i++) {
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
        }
    }
    return crc;
}

/* 组帧并发送；payload 固定 4*count 字节 */
static int nnwave_frame(nnwave_t *h, uint8_t type, uint8_t count, const uint8_t *payload) {
    uint8_t buf[6 + 4 * NNWAVE_MAX_CHANNELS];
    size_t len = 6 + 4 * (size_t)count;
    if (!h || !h->write || count == 0 || count > NNWAVE_MAX_CHANNELS) return -1;
    buf[0] = 0xAA;
    buf[1] = 0x55;
    buf[2] = type;
    buf[3] = count;
    buf[4] = h->seq++;
    memcpy(buf + 5, payload, 4 * (size_t)count);
    buf[len - 1] = nnwave_crc8(buf + 2, len - 3);
    return h->write(buf, len);
}

int nnwave_init(nnwave_t *h, int (*write)(const uint8_t *data, size_t len)) {
    if (!h || !write) return -1;
    h->write = write;
    h->seq = 0;
    return 0;
}

int nnwave_send(nnwave_t *h, const float *channels, uint8_t count) {
    if (!h || !channels) return -1;
    /* float32 小端 = 常见 MCU（ARM/x86/RISC-V 小端核）的内存布局，直接透传 */
    return nnwave_frame(h, 0x01, count, (const uint8_t *)channels);
}

int nnwave_send_names(nnwave_t *h, const char *const *names, uint8_t count) {
    uint8_t payload[4 * NNWAVE_MAX_CHANNELS];
    size_t p = 0;
    if (!h || !names) return -1;
    memset(payload, 0, sizeof(payload));
    for (uint8_t i = 0; i < count; i++) {
        const char *s = names[i] ? names[i] : "";
        size_t n = strlen(s);
        if (n > 62) n = 62; /* 单名最长 62 字节，留 1 字节长度位 */
        if (p + 1 + n > 4 * (size_t)count) break;
        payload[p++] = (uint8_t)n;
        memcpy(payload + p, s, n);
        p += n;
    }
    return nnwave_frame(h, 0x02, count, payload);
}
`,
  },
  {
    name: 'README.md',
    text: `# NN-Wave 固件接入说明

## 1. 加入工程

把 \`nnwave.c\` / \`nnwave.h\` 加入你的固件工程；

## 2. 实现发送回调（以 STM32 HAL 为例）

\`\`\`c
static int uart_write(const uint8_t *d, size_t n) {
    return HAL_UART_Transmit(&huart1, (uint8_t *)d, (uint16_t)n, 20) == HAL_OK ? 0 : -1;
}
\`\`\`

## 3. 初始化并周期性发送

\`\`\`c
nnwave_t nnw;
float ch[3] = {0};

nnwave_init(&nnw, uart_write);
const char *names[3] = {"温度", "湿度", "电流"};
nnwave_send_names(&nnw, names, 3);   /* 可选：上电发一次通道名 */

while (1) {
    ch[0] = read_temp();  ch[1] = read_humi();  ch[2] = read_current();
    nnwave_send(&nnw, ch, 3);
    HAL_Delay(10);       /* 100 Hz 刷新 */
}
\`\`\`

## 4. 上位机

NNSerialTool 波形插件 → 数据源选对应会话。

## 通道数上限

**最多 64 通道**（协议 N 字段为 1 字节，固件 \`NNWAVE_MAX_CHANNELS\` 与上位机解析器统一按 64 校验，
超出即整帧丢弃）。通道数在 \`nnwave_send\` 的 \`count\` 参数里逐帧指定，可动态增减；
上位机按本帧 N 值自动扩展图例。每通道在引擎里为 200 万点环形缓冲。

注意：通道名帧 payload 容量 = 4×N 字节，每个名字占 len+1 字节（C/Rust 模板一致）；
中文名每字 3 字节，N 较小时请用短名（如 "T1"）。

## 带宽参考

帧长 = 6 + 4×通道数 字节。
8 通道 @100Hz ≈ 3.3 KB/s，9600 波特率即可跑；1 通道 @1kHz ≈ 10 KB/s；
64 通道 @100Hz ≈ 26.2 KB/s，建议 115200 及以上波特率。
大端核（极少见）需在 \`nnwave_send\` 里逐字节装填 float。`,
  },
];
