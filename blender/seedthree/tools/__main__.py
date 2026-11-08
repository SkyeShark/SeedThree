"""python -m seedthree.tools <command> [args]: the app's scripts/ commands."""

import sys

from . import run

if __name__ == '__main__':
    sys.exit(run(sys.argv[1:]))
