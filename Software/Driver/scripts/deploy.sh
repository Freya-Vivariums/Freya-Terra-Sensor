#!/bin/bash

##
#   deploy.sh
#   For development, this script automates 
#   the deployment of your current project to a
#   remote device on your local network (using sshpass).
##

DEFAULT_USER=spuq
DEFAULT_HOST=192.168.1.113
PROJECT=Freya
COMPONENT=sensor-driver
COMPONENTTYPE=hardware
SERVICENAME="freya.sensor.terra"
APPDIR=/opt/${PROJECT}/${COMPONENTTYPE}/${COMPONENT}

# Let's start with an empty terminal
clear;

# Check whether sshpass is installed
if [[ -z $(which sshpass) ]]; then
    echo "install sshpass to continue. (sudo apt install sshpass)"
    exit 1;
fi

# Remote access credentials
echo -e '\e[0;33m-------------------------------------- \e[m'
echo -e '\e[0;33m For accessing the remote device, the  \e[m'
echo -e '\e[0;33m login credentials are required.       \e[m'
echo -e '\e[0;33m-------------------------------------- \e[m'
# Enter the IP address of the Edgeberry device
read -e -i "$DEFAULT_HOST" -p "Hostname: " HOST
if [[ -z "$HOST" ]]; then
    HOST=$DEFAULT_HOST
fi
# Enter the remote user name
read -e -i "$DEFAULT_USER" -p "User: " USER
if [[ -z "$USER" ]]; then
    USER=$DEFAULT_USER
fi
# Enter the remote user password
# note: character display disabled
stty -echo
read -p "Password: " PASSWORD
stty -echo
echo ''
echo ''

# Build the project locally
npm run build

# Uninstalling the previous version of the project
echo -e '\e[0;32mUninstalling the previous version of the project... \e[m'
sshpass -p ${PASSWORD} ssh -o StrictHostKeyChecking=no ${USER}@${HOST} << EOF
    sudo su;
    bash $APPDIR/uninstall.sh
EOF

# Copy the relevant project files to the device
echo -e '\e[0;32mCopying project to device...\e[m'
sshpass -p ${PASSWORD} scp -r   ./package.json \
                                ./build/ \
                                ./config/${SERVICENAME}.conf \
                                ./config/${SERVICENAME}.service \
                                ./scripts/uninstall.sh \
                                ${USER}@${HOST}:${APPDIR}

# Install the application on remote device
sshpass -p ${PASSWORD} ssh -o StrictHostKeyChecking=no ${USER}@${HOST} << EOF 
    sudo su
    echo -e '\e[0;32mInstalling project dependencies... \e[m'
    cd $APPDIR/
    npm install
    if [ $? -eq 0 ]; then
        echo -e "\e[0;32m[Success]\e[0m"
    else
        echo -e "\e[0;33m[Failed]\e[0m"
    fi

    # Install the application's DBus configuration file
    echo -e -n '\e[mInstalling DBus system configuration \e[m'
    mv -f ${APPDIR}/${SERVICENAME}.conf /etc/dbus-1/system.d/
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

    # Install the systemd service
    echo -e -n '\e[mInstalling systemd service \e[m'
    mv -f ${APPDIR}/${SERVICENAME}.service /etc/systemd/system/
    systemctl daemon-reload
    if [ $? -eq 0 ]; then
        echo -e "\e[0;32m[Success]\e[0m"
    else
        echo -e "\e[0;33m[Failed]\e[0m";
    fi

    # Enable the service to run on boot
    echo -e -n '\e[mEnabling service to run on boot \e[m'
    systemctl enable ${SERVICENAME}
    if [ $? -eq 0 ]; then
        echo -e "\e[m[Success]\e[0m"
    else
        echo -e "\e[0;33m[Failed]\e[0m";
    fi

    # (re)start application
    echo -e '\e[0;32mRestarting the application... \e[m'
    systemctl restart ${SERVICENAME}
    
EOF

exit 0;