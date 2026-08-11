#!/bin/bash

##
#   build.sh
#   Build the @freya-vivariums/freya-terra-sensor-node-red-contrib package
#
#   Compiles the TypeScript nodes into build/ and puts each node's editor html
#   next to its compiled javascript. The package is published from this
#   directory, so nothing needs to be copied or rewritten here:
#   package.json already points node-red.nodes at build/, and npm picks up
#   package.json, README and LICENSE by itself.
##

# Stop on the first error, so a failed compile can never leave a
# half-built folder behind for npm to publish.
set -e

BUILD_DIR=build

# Remove the old build folder
echo -e "Removing folder '$BUILD_DIR'";
rm -rf $BUILD_DIR/;

# Convert the TypeScript to JavaScript
tsc;

# Copy all the nodes their html files to their right sub-folder in the build/ folder
rsync -av --include='*/' --include='*.html' --exclude='*' nodes/ ${BUILD_DIR}/nodes/

exit 0;
