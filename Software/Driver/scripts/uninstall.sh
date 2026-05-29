#!/bin/bash

##
#   Uninstall.sh
#   Removes and cleans up the sensor driver
#   component for the Freya Vivarium Control System project.
#
#   Copyright© 2025 Sanne “SpuQ” Santens
#   Released under the MIT License (see LICENSE.txt)
##

PROJECT=Freya
COMPONENT=sensor-driver
COMPONENTTYPE=hardware
SYSTEMSERVICENAME=freya.sensor.terra
APPDIR=/opt/${PROJECT}/${COMPONENTTYPE}/${COMPONENT}

# Check if this script is running as root. If not, notify the user
# to run this script again as root and cancel the uninstallation process
if [ "$EUID" -ne 0 ]; then
    echo -e "\e[0;31mUser is not root. Exit.\e[0m"
    echo -e "\e[0mRun this script again as root\e[0m"
    exit 1;
fi

# Continue with a clean screen
clear;

##
#   Service teardown
##

# Remove the DBus config file
rm /etc/dbus-1/system.d/${SYSTEMSERVICENAME}.conf
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m"
fi
# Restarting the DBus system service
echo -e -n '\e[mRestarting the DBus system service \e[m'
systemctl reload dbus.service
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m";
fi

# Stop the systemd service
echo -n -e "\e[0mStopping systemd service \e[0m"
systemctl stop ${SYSTEMSERVICENAME}.service >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m"
fi

# Disable the service on boot
echo -n -e "\e[0mDisabling systemd service on boot \e[0m"
systemctl disable ${SYSTEMSERVICENAME}.service >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m"
fi

# Remove the service file
echo -n -e "\e[0mRemoving systemd service file \e[0m"
rm -f /etc/systemd/system/${SYSTEMSERVICENAME}.service >/dev/null 2>&1
systemctl daemon-reload >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m"
fi

##
#   Application cleanup
##

# Remove application directory
echo -n -e "\e[0mRemoving application directory \e[0m"
rm -rf ${APPDIR} >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo -e "\e[0;32m[Success]\e[0m"
else
    echo -e "\e[0;33m[Failed]\e[0m"
fi

##
#   Finish uninstallation
##

echo ""
echo -e "The \033[1m${PROJECT} ${COMPONENT}\033[0m was successfully uninstalled!"
echo ""

exit 0;