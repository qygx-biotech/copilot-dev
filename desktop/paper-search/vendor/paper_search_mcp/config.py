"""Desktop anonymous-provider build: never load environment credentials or user .env files."""
def get_env(name, default=""):
    return default
