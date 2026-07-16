; Education Advisor - NSIS 安装钩子
; 在安装前后执行自定义操作

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "正在安装 ${PRODUCTNAME} ${VERSION}，请稍候..."
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "${PRODUCTNAME} 安装完成，正在配置..."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "正在卸载 ${PRODUCTNAME}..."
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
