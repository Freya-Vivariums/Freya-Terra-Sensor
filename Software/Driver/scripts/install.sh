#!/bin/bash

##
#   Install.sh
#   Downloads and installs the latest version of the sensor driver
#   component for the Freya Vivarium Control System project.
#
#   Copyright© 2025 Sanne “SpuQ” Santens
#   Released under the MIT License (see LICENSE.txt)
#
#  ----------------------------------------------------------------------------
#   Contract
#  ----------------------------------------------------------------------------
#
#   Usage:  install.sh [--embedded]
#
#     --embedded   this installer is running inside another one (the Freya
#                  Vivarium Control System installer). It then does not clear
#                  the screen and does not print its own closing banner, since
#                  the parent owns both. Failures are still printed either way.
#
#   Exit codes, which the parent installer relies on:
#
#     0   installed
#     1   one or more steps failed - the driver may not run
#     2   installed, but this device must be rebooted before the hardware works
#
#   This driver returns 2 after enabling the I2C bus: the overlay is applied by
#   the firmware at boot, so /dev/i2c-1 does not exist until the Pi restarts.
#
#   'problems' counts steps that reported [Failed] without aborting. It is what
#   decides between exit 0 and exit 1, so a partial install is never reported as
#   a success.
#
#   Node.js is shared with the rest of the device - Edgeberry and the Freya
#   Node-RED runtime use the same /usr/bin/node. It is installed here when
#   missing and otherwise left alone; never upgraded from this script.
#
#   This downloads a release asset named after the repository, as
#   <repository>-v<x>.<y>.<z>.tar.gz, produced by the release workflow in
#   Freya-Terra-Sensor. REPONAME below must match the repository, and
#   the release must be tagged vX.Y.Z - a tag like v1.0 or v1.0.0-rc1 does not
#   match the pattern and the asset will not be found.
##

PROJECT=Freya
COMPONENT=sensor-driver
COMPONENTTYPE=hardware
SYSTEMSERVICENAME=freya.sensor.terra
# The GitHub repository this driver is released from. Used both for the release
# API lookup and to recognise the release asset, which the release workflow
# names after the repository.
REPONAME=Freya-Terra-Sensor
REPOOWNER=Freya-Vivariums
APPDIR=/opt/${PROJECT}/${COMPONENTTYPE}/${COMPONENT}

##
#   Invocation
#   This installer is run directly by a user, and also by the Freya Vivarium
#   Control System installer. Running inside another installer it must not take
#   over the screen or announce that the installation is finished - the parent
#   installer owns both of those.
##
EMBEDDED=false
for argument in "$@"; do
    case "${argument}" in
        --embedded) EMBEDDED=true ;;
        *)
            echo -e "\e[0;31mUnknown option '${argument}'\e[0m" >&2
            echo "Usage: install.sh [--embedded]" >&2
            exit 1
            ;;
    esac
done

# Steps that report [Failed] without aborting are counted, so the closing
# message can tell the truth about what happened instead of always claiming
# success.
problems=0

# Set when the I2C bus was enabled but will not exist until the device reboots.
REBOOT_REQUIRED=false


# Check if this script is running as root. If not, notify the user
# to run this script again as root and cancel the installtion process
if [ "$EUID" -ne 0 ]; then
    echo -e "\e[0;31mUser is not root. Exit.\e[0m"
    echo -e "\e[0mRun this script again as root\e[0m"
    exit 1;
fi

# Continue with a clean screen - but never when running inside another
# installer, where it would wipe everything printed so far.
if [ "${EMBEDDED}" != true ]; then
    clear;
fi

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

# Enable the I2C bus. The Terra sensors (BME680, VEML6030, AS7331) sit on the
# Raspberry Pi's I2C bus, which is disabled by default - without it there is no
# /dev/i2c-1 and this driver cannot read anything.
# raspi-config is the supported way to enable it: it writes to the config.txt
# the firmware actually reads, which is not in the same place on every
# Raspberry Pi OS version, and it updates /etc/modules as well.
echo -n -e "\e[0mEnabling the I2C bus \e[0m"
if [ -e /dev/i2c-1 ]; then
    echo -e "\e[0;32m[Already enabled] \e[0m";
elif ! which raspi-config >/dev/null 2>&1; then
    # Not a Raspberry Pi, or a system without the Raspberry Pi tooling. Nothing
    # safe to edit here, so say what is missing and let the user handle it.
    echo -e "\e[0;33m[Skipped] \e[0m";
    echo -e "\e[0m    raspi-config is not available, so the I2C bus cannot be enabled here.\e[0m";
    echo -e "\e[0m    Enable it by hand: this driver needs /dev/i2c-1 to reach the sensors.\e[0m";
    problems=$((problems+1));
else
    i2c_output=$(raspi-config nonint do_i2c 0 2>&1)
    if [ $? -eq 0 ]; then
        echo -e "\e[0;32m[Success]\e[0m"
        # dtparam is applied by the firmware at boot, so the bus node normally
        # only appears after a restart.
        if [ ! -e /dev/i2c-1 ]; then
            REBOOT_REQUIRED=true
        fi
    else
        echo -e "\e[0;33m[Failed]\e[0m";
        echo "${i2c_output}" | sed 's/^/    /' >&2
        problems=$((problems+1));
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
    problems=$((problems+1));
fi
# Reloading the DBus system service
echo -e -n '\e[mRestarting the DBus system service \e[m'
systemctl reload dbus.service
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m"
    problems=$((problems+1));
fi

# Install the application's systemd service
echo -e -n '\e[mInstalling systemd service \e[m'
mv -f ${APPDIR}/${SYSTEMSERVICENAME}.service /etc/systemd/system/
systemctl daemon-reload
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m"
    problems=$((problems+1));
fi
# Enable the application's service to run on boot
echo -e -n '\e[mEnabling systemd service to run on boot \e[m'
systemctl enable ${SYSTEMSERVICENAME}.service
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m"
    problems=$((problems+1));
fi

# Start the service
echo -e -n '\e[mStarting the systemd service \e[m'
systemctl start ${SYSTEMSERVICENAME}.service
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m"
    problems=$((problems+1));
fi


##
#   Finish installation
##

# Always report a pending reboot, embedded or not: the driver is installed and
# running but cannot read a single sensor until the I2C bus exists.
if [ "${REBOOT_REQUIRED}" = true ]; then
    echo ""
    echo -e "\e[0;33mThe I2C bus was enabled, but /dev/i2c-1 does not exist yet.\e[0m"
    echo -e "\e[0;33mReboot this device before the ${PROJECT} ${COMPONENT} can read the sensors.\e[0m"
fi

if [ ${problems} -eq 0 ]; then
    # Only the standalone run announces the result; when embedded the
    # parent installer reports it.
    if [ "${EMBEDDED}" != true ]; then
        echo ""
        echo -e "The \033[1m${PROJECT} ${COMPONENT}\033[0m was successfully installed!"
        echo ""
    fi
    # Remove this script
    rm -- "$0"
    # Exit 2 means "installed, but this device must be rebooted first", so a
    # calling installer can pass that on instead of reporting plain success.
    if [ "${REBOOT_REQUIRED}" = true ]; then
        exit 2;
    fi
    exit 0;
fi

# Something failed without aborting the installation. Say so, and exit
# non-zero so a calling script sees it too.
echo -e "\e[0;33m${PROJECT} ${COMPONENT}: ${problems} step(s) failed - the driver may not run.\e[0m" >&2
# Remove this script
rm -- "$0"

exit 1;