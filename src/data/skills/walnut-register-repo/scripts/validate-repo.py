#!/usr/bin/env python3
"""
Validate Walnut repository YAML files.

Usage:
  python3 validate-repo.py <path-to-yaml>
  python3 validate-repo.py --all              # validate all repos in ~/.open-walnut/repositories/
"""

import sys
import os
import glob

def validate_repo(filepath: str) -> tuple[list[str], list[str]]:
    """Validate a single repo YAML file. Returns (errors, warnings)."""
    errors = []
    warnings = []

    if not os.path.exists(filepath):
        errors.append(f"File not found: {filepath}")
        return errors, warnings

    try:
        import yaml
        with open(filepath, 'r') as f:
            data = yaml.safe_load(f)
    except ImportError:
        # Fallback: basic validation without pyyaml
        return validate_repo_basic(filepath)
    except Exception as e:
        errors.append(f"YAML parse error: {e}")
        return errors, warnings

    if not isinstance(data, dict):
        errors.append("File must contain a YAML mapping (key: value pairs)")
        return errors, warnings

    # Required fields
    if not data.get('name'):
        errors.append("Missing required field: name")

    if not data.get('description'):
        errors.append("Missing required field: description")

    # Hosts validation
    hosts = data.get('hosts')
    if not hosts or not isinstance(hosts, dict):
        errors.append("Missing required field: hosts (must be a mapping with at least one host)")
    else:
        if len(hosts) == 0:
            errors.append("hosts must contain at least one entry")
        for host_label, host_info in hosts.items():
            if not isinstance(host_info, dict):
                errors.append(f"hosts.{host_label} must be a mapping")
                continue
            path = host_info.get('path')
            if not path:
                errors.append(f"hosts.{host_label} missing required field: path")
            elif not os.path.isabs(path):
                errors.append(f"hosts.{host_label}.path must be an absolute path, got: {path}")
            elif not os.path.exists(path):
                warnings.append(f"hosts.{host_label}.path does not exist: {path}")

    # Optional field type checks
    tech_stack = data.get('tech_stack')
    if tech_stack is not None and not isinstance(tech_stack, (list, str)):
        warnings.append("tech_stack should be a list or string")

    return errors, warnings


def validate_repo_basic(filepath: str) -> tuple[list[str], list[str]]:
    """Basic validation without pyyaml — checks structure via string parsing."""
    errors = []
    warnings = []

    try:
        with open(filepath, 'r') as f:
            content = f.read()
    except Exception as e:
        errors.append(f"Cannot read file: {e}")
        return errors, warnings

    lines = content.split('\n')

    has_name = False
    has_description = False
    has_hosts = False
    has_host_path = False

    for line in lines:
        stripped = line.strip()
        if line.startswith('name:') and not line.startswith('  '):
            has_name = bool(line.split(':', 1)[1].strip())
        elif line.startswith('description:') and not line.startswith('  '):
            val = line.split(':', 1)[1].strip()
            has_description = bool(val) or val in ('|', '>')
        elif line.startswith('hosts:') and not line.startswith('  '):
            has_hosts = True
        elif stripped.startswith('path:') and has_hosts:
            path_val = stripped.split(':', 1)[1].strip().strip('"').strip("'")
            if path_val:
                has_host_path = True
                if not path_val.startswith('/'):
                    errors.append(f"Host path must be absolute: {path_val}")
                elif not os.path.exists(path_val):
                    warnings.append(f"Host path does not exist: {path_val}")

    if not has_name:
        errors.append("Missing required field: name")
    if not has_description:
        errors.append("Missing required field: description")
    if not has_hosts:
        errors.append("Missing required field: hosts")
    elif not has_host_path:
        errors.append("hosts must contain at least one entry with a path")

    return errors, warnings


def main():
    if len(sys.argv) < 2:
        print("Usage: validate-repo.py <path-to-yaml> | --all")
        sys.exit(1)

    if sys.argv[1] == '--all':
        repo_dir = os.path.expanduser('~/.open-walnut/repositories')
        if not os.path.exists(repo_dir):
            print(f"No repositories directory found at {repo_dir}")
            sys.exit(0)

        files = sorted(glob.glob(os.path.join(repo_dir, '*.yaml')) +
                       glob.glob(os.path.join(repo_dir, '*.yml')))
        if not files:
            print("No repository YAML files found.")
            sys.exit(0)

        all_ok = True
        for filepath in files:
            name = os.path.basename(filepath)
            errors, warnings = validate_repo(filepath)
            if errors:
                all_ok = False
                print(f"FAIL {name}:")
                for e in errors:
                    print(f"  ERROR: {e}")
            if warnings:
                print(f"WARN {name}:" if not errors else "")
                for w in warnings:
                    print(f"  WARNING: {w}")
            if not errors and not warnings:
                print(f"OK   {name}")

        sys.exit(0 if all_ok else 1)
    else:
        filepath = sys.argv[1]
        errors, warnings = validate_repo(filepath)

        if errors:
            print(f"FAIL: {filepath}")
            for e in errors:
                print(f"  ERROR: {e}")
            for w in warnings:
                print(f"  WARNING: {w}")
            sys.exit(1)
        elif warnings:
            print(f"OK (with warnings): {filepath}")
            for w in warnings:
                print(f"  WARNING: {w}")
            sys.exit(0)
        else:
            print(f"OK: {filepath}")
            sys.exit(0)


if __name__ == '__main__':
    main()
