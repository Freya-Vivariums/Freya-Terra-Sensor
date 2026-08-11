#!/bin/bash

##
#   Install.sh
#   Downloads and installs the latest version of the sensor driver
#   component for the Freya Vivarium Control System project.
#
#   Copyright© 2025 Sanne “SpuQ” Santens
#   Released under the MIT License (see LICENSE.txt)
##

PROJECT=Freya
COMPONENT=sensor-driver
COMPONENTTYPE=hardware
SYSTEMSERVICENAME=freya.sensor.terra
REPONAME=${PROJECT}-${COMPONENT}
REPOOWNER=Freya-Vivariums
APPDIR=/opt/${PROJECT}/${COMPONENTTYPE}/${COMPONENT}

# Check if this script is running as root. If not, notify the user
# to run this script again as root and cancel the installtion process
if [ "$EUID" -ne 0 ]; then
    echo -e "\e[0;31mUser is not root. Exit.\e[0m"
    echo -e "\e[0mRun this script again as root\e[0m"
    exit 1;
fi

# Continue with a clean screen
clear;

##
#   Dependencies
#   Install system dependencies for this service
#   and installation script to work correctly
##

# Check for NodeJS. If it's not installed, install it.
echo -n -e "\e[0mChecking for NodeJS \e[0m"
if which node >/dev/null 2>&1; then 
    echo -e "\e[0;32m[Installed] \e[0m";
else 
    echo -e "\e[0;33m[Not installed] \e[0m";
    echo -n -e "\e[0mInstalling Node using apt \e[0m";
    apt install -y nodejs > /dev/null 2>&1;
    # Check if the last command succeeded
    if [ $? -eq 0 ]; then
        echo -e "\e[0;32m[Success]\e[0m"
    else
        echo -e "\e[0;33mFailed! Exit.\e[0m";
        exit 1;
    fi
fi

# Check for NPM. If it's not installed, install it.
echo -n -e "\e[0mChecking for Node Package Manager (NPM) \e[0m"
if which npm >/dev/null 2>&1; then 
    echo -e "\e[0;32m[Installed] \e[0m"; 
else 
    echo -e "\e[0;33m[Not installed] \e[0m";
    echo -n -e "\e[0mInstalling NPM using apt \e[0m";
    apt install -y npm > /dev/null 2>&1;
    # Check if the last command succeeded
    if [ $? -eq 0 ]; then
        echo -e "\e[0;32m[Success]\e[0m"
    else
        echo -e "\e[0;33mFailed! Exit.\e[0m";
        exit 1;
    fi
fi

# Check for JQ (required by this script). If it's not installed,
# install it.
echo -n -e "\e[0mChecking for jq \e[0m"
if which jq >/dev/null 2>&1; then  
    echo -e "\e[0;32m[Installed] \e[0m"; 
else 
    echo -e "\e[0;33m[Not installed] \e[0m";
    echo -n -e "\e[0mInstalling jq using apt \e[0m";
    apt install -y jq > /dev/null 2>&1
    # Check if the last command succeeded
    if [ $? -eq 0 ]; then
        echo -e "\e[0;32m[Success]\e[0m"
    else
        echo -e "\e[0;33mFailed! Exit.\e[0m";
        exit 1;
    fi
fi

##
#   Application:
#   Look up and download the latest version from GitHub,
#   then put all the required files in their right place
#   to start the actual installation.
##

# Check for the latest release of the application using the GitHub API
echo -n -e "\e[0mGetting latest ${PROJECT} ${COMPONENT} release info \e[0m"
latest_release=$(curl -H "Accept: application/vnd.github.v3+json" -s "https://api.github.com/repos/${REPOOWNER}/${REPONAME}/releases/latest")
# Check if this was successful
if [ -n "$latest_release" ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33mFailed to get latest ${PROJECT} ${COMPONENT} release info! Exit.\e[0m";
    exit 1;
fi
# Get the asset download URL from the release info
echo -n -e "\e[0mGetting the latest ${PROJECT} ${COMPONENT} release download URL \e[0m"
#asset_url=$(echo "$latest_release" | jq -r `.assets[] | select(.name | test("${REPONAME}-v[0-9]+\\.[0-9]+\\.[0-9]+\\.tar\\.gz")) | .url`)
# assume $REPONAME is already set, and you've downloaded "$latest_release" via GitHub API
asset_url=$(
  echo "$latest_release" \
    | jq -r \
        --arg re "${REPONAME}-v[0-9]+\\.[0-9]+\\.[0-9]+\\.tar\\.gz" \
        '.assets[]
         | select(.name | test($re))
         | .browser_download_url'
)
# If we have an asset URL, download the tarball
if [ -n "$asset_url" ]; then
    #echo -e "\e[0;32mURL:\e[0m ${asset_url}";
    echo -e "\e[0;32m[Success]\e[0m"; 
    echo -n -e "\e[0mDownloading the application \e[0m"
    curl -L \
    -H "Accept: application/octet-stream" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -o "repo.tar.gz" \
    "$asset_url" > /dev/null 2>&1
    # Check if the download was successful
    if [ $? -eq 0 ]; then
        echo -e "\e[0;32m[Success]\e[0m"
    else
        echo -e "\e[0;33mFailed! Exit.\e[0m";
        exit 1;
    fi
else
    echo -e "\e[0;33mFailed! Exit.\e[0m";
    exit 1;
fi

# Untar the application in the application folder
echo -n -e "\e[0mUnpacking the application \e[0m"
mkdir -p ${APPDIR}  > /dev/null 2>&1;
tar -xvzf repo.tar.gz -C ${APPDIR} > /dev/null 2>&1
# Check if the last command succeeded
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33mFailed! Exit.\e[0m";
    exit 1;
fi


##
#   Application:
#   Actually installing the application
##

# Install package dependencies.
# The service runs the prebuilt build/index.js that ships with the release, so
# the device needs the runtime dependencies only. --omit=dev keeps the build
# tooling off the device.
echo -n -e "\e[0mInstalling dependencies \e[0m"
npm_output=$(npm install --omit=dev --prefix ${APPDIR} 2>&1)
# Check if the last command succeeded
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33mFailed! Exit.\e[0m";
    echo "${npm_output}" >&2
    exit 1;
fi

# Cleanup the download
rm -rf repo.tar.gz

# Install the application's DBus configuration file
echo -e -n '\e[mInstalling DBus system configuration \e[m'
mv -f ${APPDIR}/${SYSTEMSERVICENAME}.conf /etc/dbus-1/system.d/
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m"
fi
# Reloading the DBus system service
echo -e -n '\e[mRestarting the DBus system service \e[m'
systemctl reload dbus.service
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m";
fi

# Install the application's systemd service
echo -e -n '\e[mInstalling systemd service \e[m'
mv -f ${APPDIR}/${SYSTEMSERVICENAME}.service /etc/systemd/system/
systemctl daemon-reload
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m";
fi
# Enable the application's service to run on boot
echo -e -n '\e[mEnabling systemd service to run on boot \e[m'
systemctl enable ${SYSTEMSERVICENAME}.service
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m";
fi

# Start the service
echo -e -n '\e[mStarting the systemd service \e[m'
systemctl start ${SYSTEMSERVICENAME}.service
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m";
fi


##
#   Finish installation
##
echo ""
echo -e "The \033[1m${PROJECT} ${COMPONENT}\033[0m was successfully installed!"
echo ""
# Remove this script
rm -- "$0"

exit 0;