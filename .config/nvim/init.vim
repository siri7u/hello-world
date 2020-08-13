
syntax on
let g:html_indent_script1 = "inc" 
let g:html_indent_style1 = "inc" 

set relativenumber


set tabstop=2
set shiftwidth=2



set nu
set nowrap

set noswapfile
set nobackup
set undodir=~/.vim/undodir
set undofile

set termguicolors
set scrolloff=8
set noshowmode

" Give more space for displaying messages.
set cmdheight=2

" Having longer updatetime (default is 4000 ms = 4 s) leads to noticeable
" delays and poor user experience.
set updatetime=50

" Don't pass messages to |ins-completion-menu|.
set shortmess+=c

set colorcolumn=80
highlight ColorColumn ctermbg=0 guibg=lightgrey

call plug#begin('~/.vim/plugged')
Plug 'gruvbox-community/gruvbox'

Plug 'colepeters/spacemacs-theme.vim'
Plug 'sainnhe/gruvbox-material'
Plug 'phanviet/vim-monokai-pro'
Plug 'vim-airline/vim-airline'
Plug 'flazz/vim-colorschemes'

call plug#end()

let g:gruvbox_invert_selection='0'


colorscheme gruvbox
set background=dark

