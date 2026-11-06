//! 终端字节流的 UTF-8 增量解码。
//!
//! PTY / SSH 通道按任意字节边界返回数据，一个多字节字符可能被拆到两次 read 中。
//! 若每块独立做 `from_utf8_lossy`，被拆开的字符会变成 2 个 U+FFFD：
//! 框线、`⏺`、`…` 这类 3 字节单宽字符从 1 列变成 2 列，整行右移，
//! TUI 的局部重绘随之错位并残留上一帧字符。这里把块尾不完整的字节留到下一块拼接。

/// 有状态的 UTF-8 解码器：每个输出流（会话）独立持有一个实例。
#[derive(Debug, Default)]
pub(super) struct TerminalUtf8Decoder {
    /// 上一块末尾尚未凑齐的字符字节；合法 UTF-8 的不完整前缀最多 3 字节。
    pending: [u8; 3],
    pending_len: usize,
}

impl TerminalUtf8Decoder {
    /// 解码一块新读到的字节；返回其中所有完整字符，块尾的不完整字符留待下一块补齐。
    /// 真正非法的字节序列与 `String::from_utf8_lossy` 行为一致（每个最大非法子段替换为一个 U+FFFD）。
    pub(super) fn decode(&mut self, bytes: &[u8]) -> String {
        if self.pending_len == 0 {
            // 绝大多数块本身完整：零额外拷贝的快速路径，开销与原先的 from_utf8_lossy 相同。
            if let Ok(text) = std::str::from_utf8(bytes) {
                return text.to_owned();
            }
            let mut output = String::with_capacity(bytes.len());
            self.decode_into(bytes, &mut output);
            return output;
        }

        // 存在跨块残留时才拼接；残留至多 3 字节，额外拷贝只发生在字符恰好被切开的那一块。
        let mut combined = Vec::with_capacity(self.pending_len + bytes.len());
        combined.extend_from_slice(&self.pending[..self.pending_len]);
        combined.extend_from_slice(bytes);
        self.pending_len = 0;
        let mut output = String::with_capacity(combined.len());
        self.decode_into(&combined, &mut output);
        output
    }

    /// 流结束时冲刷残留字节；残留必然是不完整字符，按 lossy 规则输出替换符。
    pub(super) fn finish(&mut self) -> String {
        let pending_len = std::mem::take(&mut self.pending_len);
        if pending_len == 0 {
            return String::new();
        }
        String::from_utf8_lossy(&self.pending[..pending_len]).into_owned()
    }

    /// 逐段校验：合法段直接追加，非法段替换为 U+FFFD，块尾不完整前缀存入 pending。
    fn decode_into(&mut self, bytes: &[u8], output: &mut String) {
        let mut rest = bytes;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    output.push_str(text);
                    return;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    // valid_up_to 之前已被校验为合法 UTF-8，这里不会失败。
                    output.push_str(std::str::from_utf8(&rest[..valid_up_to]).unwrap_or_default());
                    match error.error_len() {
                        // 中间出现非法字节：与 lossy 一致替换后继续解析剩余部分。
                        Some(invalid_len) => {
                            output.push('\u{FFFD}');
                            rest = &rest[valid_up_to + invalid_len..];
                        }
                        // 块尾是被截断的字符前缀（1～3 字节），保留到下一块再解码。
                        None => {
                            let tail = &rest[valid_up_to..];
                            self.pending[..tail.len()].copy_from_slice(tail);
                            self.pending_len = tail.len();
                            return;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TerminalUtf8Decoder;

    /// 按给定切点把字节流分块喂给解码器，返回拼接后的完整输出。
    fn decode_in_chunks(bytes: &[u8], cuts: &[usize]) -> String {
        let mut decoder = TerminalUtf8Decoder::default();
        let mut output = String::new();
        let mut start = 0;
        for &cut in cuts.iter().chain(std::iter::once(&bytes.len())) {
            output.push_str(&decoder.decode(&bytes[start..cut]));
            start = cut;
        }
        output.push_str(&decoder.finish());
        output
    }

    #[test]
    fn multibyte_chars_split_at_every_position_decode_intact() {
        // 覆盖 Claude Code 常见的 3 字节单宽字符、中文、4 字节 emoji 与 ZWJ 组合。
        let text = "⏺ 读取 ─│⎿ … ✻ 🤖 👨‍💻 ⚠️ ok\r\n";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            assert_eq!(decode_in_chunks(bytes, &[cut]), text, "cut at {cut}");
        }
    }

    #[test]
    fn byte_by_byte_feeding_decodes_intact() {
        let text = "中文─⏺🤖\x1b[2K\x1b[1A末尾";
        let bytes = text.as_bytes();
        let cuts: Vec<usize> = (1..bytes.len()).collect();
        assert_eq!(decode_in_chunks(bytes, &cuts), text);
    }

    #[test]
    fn invalid_bytes_match_lossy_behavior_regardless_of_split() {
        // GBK 字节、孤立续字节、过长编码等非法输入：结果必须与整段 lossy 一致，不吞字节也不多出替换符。
        let bytes: &[u8] = b"a\xd6\xd0\xce\xc4b\x80c\xe4\xb8d\xf0\x9f\xa4e\xc0\xaf\xe4\xb8\xad";
        let expected = String::from_utf8_lossy(bytes).into_owned();
        for cut in 0..=bytes.len() {
            assert_eq!(decode_in_chunks(bytes, &[cut]), expected, "cut at {cut}");
        }
        let cuts: Vec<usize> = (1..bytes.len()).collect();
        assert_eq!(decode_in_chunks(bytes, &cuts), expected);
    }

    #[test]
    fn truncated_tail_is_held_until_next_chunk() {
        let mut decoder = TerminalUtf8Decoder::default();
        // "─" = E2 94 80：前两字节不能提前输出成替换符。
        assert_eq!(decoder.decode(b"ab\xe2\x94"), "ab");
        assert_eq!(decoder.decode(b"\x80cd"), "─cd");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn finish_flushes_incomplete_tail_as_replacement() {
        let mut decoder = TerminalUtf8Decoder::default();
        assert_eq!(decoder.decode(b"x\xf0\x9f"), "x");
        assert_eq!(decoder.finish(), "\u{FFFD}");
        // 冲刷后状态清空，可继续正常解码。
        assert_eq!(decoder.decode("好".as_bytes()), "好");
    }

    #[test]
    fn pending_prefix_followed_by_non_continuation_byte_is_replaced() {
        let mut decoder = TerminalUtf8Decoder::default();
        assert_eq!(decoder.decode(b"\xe4\xb8"), "");
        // 下一块不是续字节：残留前缀作为一个非法子段替换，新块内容原样保留。
        assert_eq!(decoder.decode(b"A"), "\u{FFFD}A");
    }
}
