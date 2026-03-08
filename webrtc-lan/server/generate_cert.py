#!/usr/bin/env python3
"""
Generate self-signed SSL certificates for HTTPS/WSS.
Run this script once to create cert.pem and key.pem in the server directory.
"""

import subprocess
import sys
from pathlib import Path


def main():
    server_dir = Path(__file__).parent
    cert_path = server_dir / "cert.pem"
    key_path = server_dir / "key.pem"

    if cert_path.exists() and key_path.exists():
        print("Certificates already exist.")
        return

    print("Generating self-signed SSL certificates...")
    try:
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-keyout",
                str(key_path),
                "-out",
                str(cert_path),
                "-days",
                "365",
                "-nodes",
                "-subj",
                "/CN=localhost",
            ],
            check=True,
            capture_output=True,
        )
        print(f"Generated {cert_path} and {key_path}")
        print("Restart the server to enable HTTPS/WSS")
    except FileNotFoundError:
        print("Error: openssl not found. Please install openssl.", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(f"Error generating certificates: {e.stderr.decode()}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
