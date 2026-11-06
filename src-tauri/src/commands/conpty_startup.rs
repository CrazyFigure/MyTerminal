//! ConPTY 启动握手的后端就地应答。
//!
//! portable-pty 以 PSEUDOCONSOLE_INHERIT_CURSOR 创建伪控制台，ConPTY 启动时会先向终端查询光标位置，
//! 收到回复前阻塞 Shell 的全部输出。两代 ConPTY 的握手不同：
//! - 系统内置 conhost：只发 `ESC[6n`；
//! - 随包附带的新版 OpenConsole：先发 `ESC[1t`，再连发 `ESC[6n ESC[c`，并且会等 DA1 应答，最多约 3 秒。
//! 若交给前端 xterm 绕一圈回复，会受挂载、缓存重放与 connecting 状态拦截影响，首屏明显变慢，
//! 因此在后端识别并应答；握手结束后的一切输出（包括程序自己发出的同类查询）都原样透传。

/// 新建 PTY 屏幕为空，光标必然位于左上角。
pub(super) const CURSOR_POSITION_REPLY: &[u8] = b"\x1b[1;1R";
/// 与 xterm.js 自身的 DA1 应答保持一致（VT100 + AVO）；ConPTY 只把它当作“终端已处理前序查询”的信号。
pub(super) const DEVICE_ATTRIBUTES_REPLY: &[u8] = b"\x1b[?1;2c";

/// 握手阶段最多检查的输出块数；只为防御异常输出，正常情况下首个正文字符就会结束握手。
const HANDSHAKE_MAX_CHUNKS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HandshakePhase {
    /// 等待光标位置查询；此前出现的其它控制序列（如 `ESC[1t`）原样透传。
    AwaitCursorQuery,
    /// 光标查询已应答；紧随其后的若是 DA1 查询则一并应答，否则握手结束。
    AwaitDeviceAttributesQuery,
    Done,
}

/// 单个本地会话的启动握手状态机，由读线程持有。
#[derive(Debug)]
pub(super) struct ConptyStartupHandshake {
    phase: HandshakePhase,
    inspected_chunks: usize,
}

impl Default for ConptyStartupHandshake {
    fn default() -> Self {
        Self {
            phase: HandshakePhase::AwaitCursorQuery,
            inspected_chunks: 0,
        }
    }
}

impl ConptyStartupHandshake {
    /// 处理一块已解码的输出：返回需透传给前端的内容，以及需按顺序写回 PTY 的应答。
    pub(super) fn process(&mut self, content: String) -> (String, Vec<&'static [u8]>) {
        if self.phase == HandshakePhase::Done {
            return (content, Vec::new());
        }
        self.inspected_chunks += 1;

        let mut passthrough = String::new();
        let mut replies = Vec::new();
        let mut rest = content.as_str();
        while !rest.is_empty() && self.phase != HandshakePhase::Done {
            // 出现正文或不完整序列即说明握手阶段已过，剩余内容全部透传。
            let Some(sequence_len) = leading_csi_len(rest) else {
                self.phase = HandshakePhase::Done;
                break;
            };
            let sequence = &rest[..sequence_len];
            match self.phase {
                HandshakePhase::AwaitCursorQuery => {
                    if sequence == "\x1b[6n" {
                        replies.push(CURSOR_POSITION_REPLY);
                        self.phase = HandshakePhase::AwaitDeviceAttributesQuery;
                    } else {
                        passthrough.push_str(sequence);
                    }
                }
                HandshakePhase::AwaitDeviceAttributesQuery => {
                    // 只接受紧跟在光标查询之后的 DA1；旧版 conhost 这里是普通模式设置，原样透传。
                    if sequence == "\x1b[c" || sequence == "\x1b[0c" {
                        replies.push(DEVICE_ATTRIBUTES_REPLY);
                    } else {
                        passthrough.push_str(sequence);
                    }
                    self.phase = HandshakePhase::Done;
                }
                HandshakePhase::Done => unreachable!(),
            }
            rest = &rest[sequence_len..];
        }
        if self.phase != HandshakePhase::Done && self.inspected_chunks >= HANDSHAKE_MAX_CHUNKS {
            self.phase = HandshakePhase::Done;
        }

        // 一个序列都没消费时直接复用原字符串，避免额外拷贝。
        if rest.len() == content.len() {
            return (content, replies);
        }
        passthrough.push_str(rest);
        (passthrough, replies)
    }
}

/// 若内容以完整 CSI 序列（ESC [ 参数/中间字节 终止字节）开头，返回其字节长度。
fn leading_csi_len(content: &str) -> Option<usize> {
    let bytes = content.as_bytes();
    if bytes.len() < 3 || bytes[0] != 0x1b || bytes[1] != b'[' {
        return None;
    }
    for (index, &byte) in bytes.iter().enumerate().skip(2) {
        match byte {
            // 参数字节与中间字节。
            0x20..=0x3f => continue,
            // 终止字节。
            0x40..=0x7e => return Some(index + 1),
            _ => return None,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{ConptyStartupHandshake, CURSOR_POSITION_REPLY, DEVICE_ATTRIBUTES_REPLY};

    fn feed(handshake: &mut ConptyStartupHandshake, chunk: &str) -> (String, Vec<&'static [u8]>) {
        handshake.process(chunk.to_string())
    }

    #[test]
    fn inbox_conhost_handshake_answers_cursor_query_only() {
        // 系统 conhost 的实测输出序列。
        let mut handshake = ConptyStartupHandshake::default();
        assert_eq!(feed(&mut handshake, "\x1b[6n"), (String::new(), vec![CURSOR_POSITION_REPLY]));
        assert_eq!(
            feed(&mut handshake, "\x1b[?9001h\x1b[?1004h"),
            ("\x1b[?9001h\x1b[?1004h".to_string(), vec![])
        );
        // 握手结束后同样的查询属于 Shell / TUI 自身，必须透传给前端。
        assert_eq!(feed(&mut handshake, "\x1b[6n\x1b[c"), ("\x1b[6n\x1b[c".to_string(), vec![]));
    }

    #[test]
    fn sideloaded_openconsole_handshake_answers_cursor_and_device_attributes() {
        // 新版 OpenConsole 的实测输出序列：不应答 DA1 会让首屏等待约 3 秒。
        let mut handshake = ConptyStartupHandshake::default();
        assert_eq!(feed(&mut handshake, "\x1b[1t"), ("\x1b[1t".to_string(), vec![]));
        assert_eq!(
            feed(&mut handshake, "\x1b[6n\x1b[c\x1b[?1004h\x1b[?9001h"),
            (
                "\x1b[?1004h\x1b[?9001h".to_string(),
                vec![CURSOR_POSITION_REPLY, DEVICE_ATTRIBUTES_REPLY]
            )
        );
        assert_eq!(feed(&mut handshake, "\x1b[c"), ("\x1b[c".to_string(), vec![]));
    }

    #[test]
    fn device_attributes_query_split_into_next_chunk_is_still_answered() {
        let mut handshake = ConptyStartupHandshake::default();
        assert_eq!(feed(&mut handshake, "\x1b[6n"), (String::new(), vec![CURSOR_POSITION_REPLY]));
        assert_eq!(feed(&mut handshake, "\x1b[cREADY"), ("READY".to_string(), vec![DEVICE_ATTRIBUTES_REPLY]));
    }

    #[test]
    fn plain_text_before_any_query_ends_handshake() {
        // 没有握手（或查询不在开头）时一律原样透传，绝不吞掉正文里的查询。
        let mut handshake = ConptyStartupHandshake::default();
        assert_eq!(
            feed(&mut handshake, "PS C:\\> \x1b[6n"),
            ("PS C:\\> \x1b[6n".to_string(), vec![])
        );
        assert_eq!(feed(&mut handshake, "\x1b[6n"), ("\x1b[6n".to_string(), vec![]));
    }

    #[test]
    fn text_after_cursor_query_passes_through_in_same_chunk() {
        let mut handshake = ConptyStartupHandshake::default();
        assert_eq!(
            feed(&mut handshake, "\x1b[6n中文─⏺"),
            ("中文─⏺".to_string(), vec![CURSOR_POSITION_REPLY])
        );
    }

    #[test]
    fn handshake_gives_up_after_chunk_budget() {
        let mut handshake = ConptyStartupHandshake::default();
        for _ in 0..16 {
            assert_eq!(feed(&mut handshake, "\x1b[?25l"), ("\x1b[?25l".to_string(), vec![]));
        }
        // 预算耗尽后不再识别查询，避免长期驻留在握手状态。
        assert_eq!(feed(&mut handshake, "\x1b[6n"), ("\x1b[6n".to_string(), vec![]));
    }

    #[test]
    fn incomplete_sequence_ends_handshake_and_passes_through() {
        let mut handshake = ConptyStartupHandshake::default();
        assert_eq!(feed(&mut handshake, "\x1b["), ("\x1b[".to_string(), vec![]));
        assert_eq!(feed(&mut handshake, "6n"), ("6n".to_string(), vec![]));
    }
}
