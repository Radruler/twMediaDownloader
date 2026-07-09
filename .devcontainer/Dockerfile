FROM mcr.microsoft.com/devcontainers/javascript-node:latest

SHELL ["/bin/bash", "-lc"]

RUN source /usr/local/share/nvm/nvm.sh \
  && nvm install 22.12.0 \
  && nvm alias default 22.12.0 \
  && nvm use default

ENV PATH="/usr/local/share/nvm/versions/node/v22.12.0/bin:${PATH}"
