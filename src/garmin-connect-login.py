#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["garminconnect==0.3.20"]
# ///
"""Log in to Garmin Connect and write the mobile-app OAuth tokens that src/garmin.ts refreshes and uses.

Only the login needs Python: Garmin's SSO blocks clients without a browser TLS fingerprint, which
garminconnect fakes through curl_cffi. Token refresh and data calls work from plain fetch.
"""

import os
import sys

from garminconnect import Garmin

token_dir = sys.argv[1]
email, _, password = os.environ["GARMIN_CREDENTIALS"].partition(":")
interactive = sys.stdin.isatty()

garmin = Garmin(email, password, return_on_mfa=not interactive, prompt_mfa=(lambda: input("Garmin MFA code: ")) if interactive else None)
status, _ = garmin.login()
if status == "needs_mfa":
    print("Garmin wants an MFA code for this login. Run `garmin login` in a terminal to enter it.", file=sys.stderr)
    sys.exit(3)
garmin.client.dump(token_dir)
print(f"Logged in to Garmin Connect as {email}; tokens written to {token_dir}", file=sys.stderr)
