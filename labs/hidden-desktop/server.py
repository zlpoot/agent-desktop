"""Compatibility CLI for the explicitly assembled Hidden Desktop bench."""
from hidden_desktop_lab.transports.http import (
    DEFAULT_PORT, MAX_BODY, PAGE_LEASE_SECONDS, Handler, create_server, free_port, main,
)


if __name__ == "__main__":
    main()
