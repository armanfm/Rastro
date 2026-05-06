// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract RastroV3 {
    enum Risco {
        BAIXO,
        MEDIO,
        ALTO,
        PENDENTE
    }

    struct Fazenda {
        string codigoCAR;
        address dono;
        uint8 score;
        Risco risco;
        uint256 atualizadoEm;
        string cid;
        bool existe;
    }

    mapping(string => Fazenda) private fazendas;
    string[] private listaFazendas;

    event FazendaCadastrada(string codigoCAR, address dono);
    event VerificacaoAtualizada(
        string codigoCAR,
        uint8 score,
        Risco risco,
        string cid,
        uint256 atualizadoEm
    );

    function _validarFormatoCAR(string calldata car) internal pure returns (bool) {
        bytes memory b = bytes(car);
        uint256 len = b.length;

        if (len < 10) return false;
        if (b[0] < 0x41 || b[0] > 0x5A) return false;
        if (b[1] < 0x41 || b[1] > 0x5A) return false;
        if (b[2] != 0x2D) return false;

        for (uint256 i = 3; i < 10; i++) {
            if (b[i] < 0x30 || b[i] > 0x39) return false;
        }

        if (len == 10) return true;

        uint256 pos = 10;

        if (b[pos] == 0x2F) {
            if (len < pos + 6) return false;

            for (uint256 i = pos + 1; i < pos + 5; i++) {
                if (b[i] < 0x30 || b[i] > 0x39) return false;
            }

            pos = pos + 5;
        }

        if (b[pos] != 0x2D) return false;
        pos++;

        if (len <= pos) return false;

        for (uint256 i = pos; i < len; i++) {
            bool isDigit = b[i] >= 0x30 && b[i] <= 0x39;
            bool isUpper = b[i] >= 0x41 && b[i] <= 0x5A;

            if (!isDigit && !isUpper) return false;
        }

        return true;
    }

    function cadastrarCAR(string calldata codigoCAR) external {
        require(
            _validarFormatoCAR(codigoCAR),
            "Formato invalido. Use: UF-NNNNNNN ou UF-NNNNNNN/AAAA-HASH"
        );

        require(!fazendas[codigoCAR].existe, "CAR ja cadastrado");

        fazendas[codigoCAR] = Fazenda({
            codigoCAR: codigoCAR,
            dono: msg.sender,
            score: 0,
            risco: Risco.PENDENTE,
            atualizadoEm: block.timestamp,
            cid: "",
            existe: true
        });

        listaFazendas.push(codigoCAR);

        emit FazendaCadastrada(codigoCAR, msg.sender);
    }

    function registrarVerificacao(
        string calldata codigoCAR,
        uint8 score,
        uint8 risco,
        string calldata cid
    ) external {
        require(fazendas[codigoCAR].existe, "CAR nao cadastrado");
        require(score <= 100, "Score invalido");
        require(risco <= uint8(Risco.PENDENTE), "Risco invalido");

        Fazenda storage f = fazendas[codigoCAR];

        f.score = score;
        f.risco = Risco(risco);
        f.cid = cid;
        f.atualizadoEm = block.timestamp;

        emit VerificacaoAtualizada(
            codigoCAR,
            score,
            Risco(risco),
            cid,
            block.timestamp
        );
    }

    function getFazenda(
        string calldata codigoCAR
    ) external view returns (Fazenda memory) {
        require(fazendas[codigoCAR].existe, "CAR nao existe");
        return fazendas[codigoCAR];
    }

    function totalFazendas() external view returns (uint256) {
        return listaFazendas.length;
    }

    function getFazendas(
        uint256 inicio,
        uint256 fim
    ) external view returns (string[] memory) {
        require(fim <= listaFazendas.length, "Fim invalido");
        require(inicio < fim, "Range invalido");

        string[] memory resultado = new string[](fim - inicio);

        for (uint256 i = inicio; i < fim; i++) {
            resultado[i - inicio] = listaFazendas[i];
        }

        return resultado;
    }

    function listarTodos() external view returns (string[] memory) {
        return listaFazendas;
    }

    function listarTodosComDados()
        external
        view
        returns (Fazenda[] memory)
    {
        uint256 total = listaFazendas.length;
        Fazenda[] memory resultado = new Fazenda[](total);

        for (uint256 i = 0; i < total; i++) {
            resultado[i] = fazendas[listaFazendas[i]];
        }

        return resultado;
    }

    function listarPorRisco(
        uint8 risco
    ) external view returns (string[] memory) {
        uint256 count = 0;

        for (uint256 i = 0; i < listaFazendas.length; i++) {
            if (uint8(fazendas[listaFazendas[i]].risco) == risco) {
                count++;
            }
        }

        string[] memory resultado = new string[](count);
        uint256 idx = 0;

        for (uint256 i = 0; i < listaFazendas.length; i++) {
            if (uint8(fazendas[listaFazendas[i]].risco) == risco) {
                resultado[idx] = listaFazendas[i];
                idx++;
            }
        }

        return resultado;
    }

    function top10Scores() external view returns (Fazenda[] memory) {
        uint256 total = listaFazendas.length;

        if (total == 0) {
            return new Fazenda[](0);
        }

        uint256 limite = total > 10 ? 10 : total;

        Fazenda[] memory temp = new Fazenda[](total);

        for (uint256 i = 0; i < total; i++) {
            temp[i] = fazendas[listaFazendas[i]];
        }

        for (uint256 i = 0; i < total; i++) {
            for (uint256 j = i + 1; j < total; j++) {
                if (temp[j].score > temp[i].score) {
                    Fazenda memory aux = temp[i];
                    temp[i] = temp[j];
                    temp[j] = aux;
                }
            }
        }

        Fazenda[] memory top = new Fazenda[](limite);

        for (uint256 i = 0; i < limite; i++) {
            top[i] = temp[i];
        }

        return top;
    }
}