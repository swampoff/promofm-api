#!/bin/bash
# Post-deploy: recreate symlinks and files that rsync --delete removes
ln -sfn /var/www/promofm/prerender /var/www/promofm/html/_prerender
echo "Post-deploy: _prerender symlink restored"
