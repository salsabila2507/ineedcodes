---
name: vr-cheatsheet-linux_commands
description: >-
  Vulnerability research reference: linux_commands
gated: true
---
# Linux Commands Reference

## Catch Reverse Shell
`nc -lvnp 4444`

## Start Web Server
`sudo python3 -m http.server 8000`

## What shell am I using?
`echo $SHELL`

## Set Alias Permanently (Bash Shell)
```bash
echo "alias c='clear'" >> ~/.bash_aliases
echo "alias shut='sudo shutdown now'" >> ~/.bash_aliases
source ~/.bashrc
```

## Set Alias Permanently (Z Shell)
```bash
echo "alias c='clear'" >> ~/.zshrc
echo "alias shut='sudo shutdown now'" >> ~/.zshrc
source ~/.zshrc
```

## Update OS
`sudo apt update && sudo apt upgrade -y`

## Test Port With Netcat
`nc -zv <IP_ADDR> 1516`

## Check Root File Space
`df -h /`

> Source: skraft9/vulnerability-research. Authorized security work only. Gated skill: needs the developer keyword.
