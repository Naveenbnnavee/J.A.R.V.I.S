import sys
from chromadb.cli.cli import run
if __name__ == "__main__":
    sys.argv = ["chroma", "run", "--path", "./jarvis_memory_db"]
    run()
