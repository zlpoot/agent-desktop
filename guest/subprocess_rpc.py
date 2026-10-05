"""Bounded pipe exchange; a timed-out worker is killed before releasing its caller."""
import queue
import threading


def exchange(process, payload, timeout):
    replies = queue.Queue(maxsize=1)

    def communicate():
        try:
            process.stdin.write(payload + "\n")
            process.stdin.flush()
            replies.put((process.stdout.readline(), None))
        except Exception as error:
            replies.put((None, error))

    reader = threading.Thread(target=communicate, daemon=True)
    reader.start()
    try:
        line, error = replies.get(timeout=timeout)
    except queue.Empty:
        process.kill()
        process.wait(timeout=3)
        reader.join(timeout=1)
        raise TimeoutError("Guest desktop subprocess timed out; terminated, input frozen")
    if error:
        raise error
    if not line:
        raise RuntimeError("Guest desktop subprocess exited")
    return line
