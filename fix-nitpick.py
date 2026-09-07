import re

with open('packages/dsh-web-file-preview/src/client/preview.ts', 'r') as f:
    content = f.read()

# Replace the stray JSDoc comment
content = content.replace('/** 打开文件预览 Modal。 */\nfunction handleTabSwitch', 'function handleTabSwitch')

with open('packages/dsh-web-file-preview/src/client/preview.ts', 'w') as f:
    f.write(content)
