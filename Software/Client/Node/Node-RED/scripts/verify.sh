#!/bin/bash

##
#   verify.sh
#   Verify that the package npm is about to publish can actually be loaded by
#   Node-RED. This runs from prepublishOnly, so a package that fails any of
#   these checks never reaches the registry.
#
#   These checks are not hypothetical. A published package once shipped its
#   TypeScript sources instead of the compiled JavaScript: Node-RED could not
#   register the node type, and then refused to start the *entire* flow -
#   stopping all lighting, heating, misting and fan control on a live vivarium.
#   Every check below turns a variation of that into a failed publish.
##

# Stop on the first error
set -e

# Always work from the package root, whatever directory this was invoked from
cd "$(dirname "$0")/.."

# Report a check that passed
ok(){
    echo -e "  \e[0;32m[OK]\e[0m $1"
}

# Report a check that failed, and stop: nothing gets published
fail(){
    echo -e "  \e[0;31m[FAILED]\e[0m $1" >&2
    shift
    # Any remaining arguments are explanation lines
    for line in "$@"; do
        echo "         ${line}" >&2
    done
    exit 1
}

if ! which jq >/dev/null 2>&1; then
    echo "verify.sh needs jq. Install it with: sudo apt install jq" >&2
    exit 1
fi

echo -e "\e[1mVerifying $(jq -r '.name + "@" + .version' package.json)\e[0m"

##
#   The files npm would actually upload
#   'npm pack --dry-run' does not run prepublishOnly, so calling it from here
#   cannot recurse. Any lifecycle output lands on stdout ahead of the json,
#   so start reading at the opening bracket of the array.
##
packed_files=$(npm pack --dry-run --json --silent 2>/dev/null | sed -n '/^\[/,$p' | jq -r '.[0].files[].path')

if [ -z "${packed_files}" ]; then
    fail "npm would publish an empty package" \
         "Check the 'files' array in package.json."
fi

##
#   Every node Node-RED is told to load must be present and must be JavaScript
##
node_count=$(jq -r '."node-red".nodes | length' package.json)
if [ "${node_count}" = "0" ] || [ "${node_count}" = "null" ]; then
    fail "package.json declares no nodes under 'node-red'.'nodes'"
fi

while read -r node_file; do
    case "${node_file}" in
        *.js) ;;
        *) fail "node-red.nodes points at '${node_file}', which is not JavaScript" \
                "Node-RED cannot load TypeScript sources." \
                "Point it at the compiled file in build/." ;;
    esac

    if echo "${packed_files}" | grep -qx "${node_file}"; then
        ok "${node_file}"
    else
        fail "'${node_file}' is referenced by node-red.nodes but is not in the package" \
             "Either the build did not produce it, or the 'files' array in" \
             "package.json does not cover it."
    fi

    # The editor side of a node lives in its .html file: without it the node
    # has no palette entry and no edit dialog.
    html_file="${node_file%.js}.html"
    if echo "${packed_files}" | grep -qx "${html_file}"; then
        ok "${html_file}"
    else
        fail "'${html_file}' is missing from the package" \
             "A Node-RED node needs its .html file for the editor."
    fi
done < <(jq -r '."node-red".nodes[]' package.json)

##
#   No TypeScript may reach the registry. Nothing here needs to ship .ts, so
#   its presence means the build output and the 'files' array disagree.
##
if stray_ts=$(echo "${packed_files}" | grep '\.ts$'); then
    fail "the package contains TypeScript sources:" ${stray_ts}
fi
ok "no TypeScript sources in the package"

##
#   Dependencies must be installable by whoever installs this package
##
dependency_count=$(jq -r '(.dependencies // {}) | length' package.json)
if [ "${dependency_count}" != "0" ]; then
    while read -r dependency; do
        name=${dependency%%|*}
        range=${dependency##*|}

        # A 'file:' or 'link:' path means nothing once published: it installs
        # as a dangling symlink on the consumer's machine.
        case "${range}" in
            file:*|link:*)
                fail "dependency '${name}' is a local path (${range})" \
                     "Local paths cannot be published. Use a version range, and" \
                     "an npm workspace for local development."
                ;;
        esac

        # A range nobody has published yet makes this package uninstallable.
        if npm view "${name}@${range}" version >/dev/null 2>&1; then
            ok "dependency ${name}@${range} is published"
        else
            fail "dependency '${name}@${range}' does not resolve on the registry" \
                 "Publish it first, or correct the version range."
        fi
    done < <(jq -r '(.dependencies // {}) | to_entries[] | .key + "|" + .value' package.json)
fi

echo -e "\e[0;32mPackage verified.\e[0m"
exit 0;
