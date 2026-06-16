use std::{
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use crate::{
    domain::entities::{ConnectionProfile, TunnelRecord},
    error::AppError,
};

use super::connection::connect_ssh;

pub(crate) fn forward_single_connection(
    connection: ConnectionProfile,
    remote_host: String,
    remote_port: u16,
    mut local_stream: TcpStream,
    stop_flag: Arc<AtomicBool>,
) {
    let Ok(ssh_session) = connect_ssh(&connection) else {
        return;
    };

    let Ok(mut channel) = ssh_session.channel_direct_tcpip(&remote_host, remote_port, None) else {
        return;
    };

    let _ = local_stream.set_read_timeout(Some(Duration::from_millis(80)));
    let _ = local_stream.set_write_timeout(Some(Duration::from_millis(80)));

    let mut local_buffer = [0_u8; 8192];
    let mut remote_buffer = [0_u8; 8192];
    let mut local_closed = false;
    let mut remote_closed = false;

    while !(stop_flag.load(Ordering::Relaxed) || local_closed && remote_closed) {
        match local_stream.read(&mut local_buffer) {
            Ok(0) => {
                local_closed = true;
                let _ = channel.send_eof();
            }
            Ok(size) => {
                let _ = channel.write_all(&local_buffer[..size]);
                let _ = channel.flush();
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }

        match channel.read(&mut remote_buffer) {
            Ok(0) => {
                if channel.eof() {
                    remote_closed = true;
                }
            }
            Ok(size) => {
                let _ = local_stream.write_all(&remote_buffer[..size]);
                let _ = local_stream.flush();
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }

        thread::sleep(Duration::from_millis(8));
    }

    let _ = channel.close();
}

pub(crate) fn spawn_tunnel_listener(
    connection: ConnectionProfile,
    tunnel: TunnelRecord,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), AppError> {
    let listener = TcpListener::bind((tunnel.bind_address.as_str(), tunnel.local_port))?;
    listener.set_nonblocking(true)?;

    thread::spawn(move || {
        while !stop_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let connection = connection.clone();
                    let remote_host = tunnel.remote_host.clone();
                    let remote_port = tunnel.remote_port;
                    let stop = Arc::clone(&stop_flag);
                    thread::spawn(move || {
                        forward_single_connection(
                            connection,
                            remote_host,
                            remote_port,
                            stream,
                            stop,
                        );
                    });
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(40));
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}
