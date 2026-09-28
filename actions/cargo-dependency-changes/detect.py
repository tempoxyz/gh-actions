"""Read TOML as data through GitHub; never check out or execute candidate code."""
import base64
import json
import os
import re
import subprocess
import tomllib
from urllib.parse import quote


def selected(name, prefix):
    return name == prefix or name.startswith(prefix + "-")


def dependencies(text, prefix, lock=False):
    doc = tomllib.loads(text)
    if lock:
        return sorted((p["name"], p["version"], p.get("source", ""))
                      for p in doc.get("package", []) if selected(p["name"], prefix))
    found = []

    def visit(table, path=()):
        for key, value in table.items():
            if key in ("dependencies", "dev-dependencies", "build-dependencies") or (path and path[0] in ("patch", "replace")):
                for alias, spec in value.items():
                    spec = {"version": spec} if isinstance(spec, str) else spec
                    name = spec.get("package", alias)
                    if selected(name, prefix):
                        # Features and optional/default-features aren't revision bumps.
                        revision = {k: v for k, v in spec.items() if k in
                                    ("version", "git", "rev", "tag", "branch", "path", "registry", "workspace", "package")}
                        found.append((path, key, alias, json.dumps(revision, sort_keys=True)))
            elif isinstance(value, dict):
                visit(value, path + (key,))
    visit(doc)
    return sorted(found)


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def detect(repo, base, head, prefix):
    if not all(re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (base, head)):
        raise ValueError("base and head must be full commit SHAs")
    comparison = api(f"repos/{repo}/compare/{base}...{head}?per_page=1")
    files = comparison["files"]
    if len(files) >= 300:
        print("::warning::Comparison may be truncated; requiring dependency tests")
        return True
    # Match the PR's full diff, including when its branch is behind the base.
    base = comparison["merge_base_commit"]["sha"]

    def read(path, ref):
        content = api(f"repos/{repo}/contents/{quote(path, safe='/')}?ref={ref}")
        if content.get("encoding") != "base64":
            raise ValueError(f"Unsupported contents encoding for {path}")
        return base64.b64decode(content["content"]).decode()

    for file in files:
        new = file["filename"]
        old = file.get("previous_filename", new)
        if not any(p.rsplit("/", 1)[-1] in ("Cargo.toml", "Cargo.lock") for p in (old, new)):
            continue
        before = "" if file["status"] == "added" else read(old, base)
        after = "" if file["status"] == "removed" else read(new, head)
        if dependencies(before, prefix, old.endswith("Cargo.lock")) != dependencies(after, prefix, new.endswith("Cargo.lock")):
            return True
    return False


if __name__ == "__main__":
    changed = detect(os.environ["GITHUB_REPOSITORY"], os.environ["BASE"], os.environ["HEAD"], os.environ["PACKAGE_PREFIX"])
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"changed={str(changed).lower()}\n")
